/** Cloudflare Computer VFS provider for the upstream `ctx.fileReferences` seam. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  FILE_REFERENCE_PROMPT,
  FileReferenceService,
  type FileReferenceCandidate,
} from '@deepseek-ai/dsh-file-reference'

/** One directory entry as the Computer workspace filesystem reports it. */
export interface EdgeReferenceEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
}

/** The subset of the Computer workspace filesystem that discovery reads. */
export interface EdgeReferenceFiles {
  readdir(path: string, options?: { limit?: number }): Promise<readonly EdgeReferenceEntry[]>
}

export interface EdgeFileReferenceConfig {
  /** Run one discovery read against the Durable Object's Computer workspace. */
  withFiles<T>(read: (files: EdgeReferenceFiles) => Promise<T>): Promise<T>
  /** Maximum candidates returned for one query. */
  maxResults?: number
  /** Maximum files and directories one working directory's index holds. */
  maxEntries?: number
  /** Age after which an index is refreshed behind the next bare query. */
  staleAfterMs?: number
  /** Clock for index age; tests replace it. */
  now?: () => number
}

const DEFAULT_MAX_RESULTS = 20
/**
 * Upstream indexes up to 50,000 entries from the local disk. Each Edge
 * directory listing reads Durable Object rows, so one index read is bounded
 * at a fifth of that.
 */
export const DEFAULT_MAX_ENTRIES = 10_000
/**
 * Files also change outside tools: owner API writes, uploads, and commands
 * run through the HTTP exec route reach the workspace without a tool result,
 * and some never pass through this Durable Object. An index older than this
 * is refreshed behind the next bare query, as after a tool result.
 */
export const DEFAULT_STALE_AFTER_MS = 30_000
const DEFAULT_CWD = '/workspace'
/** Upstream dsh-file-reference-local's default exclusions: VCS, dependency, and build-output directories. */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target', '.next', '.nuxt', '.turbo',
  '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle',
])

/**
 * `@file` completion over the Computer VFS, following upstream
 * dsh-file-reference-local, whose node:fs walk Workers cannot run: a query
 * with a `/` (or an empty one) lists that directory, and a bare fragment
 * fuzzy-ranks a recursive index of the working directory, so `rdm` finds
 * `README.md` anywhere below it. The index skips upstream's excluded
 * directories and holds at most `maxEntries` paths. Only the first bare query
 * waits for it; after a tool result in any session (they share one
 * workspace), or once it is older than `staleAfterMs`, it is stale, and the
 * next bare query answers from it while its replacement is read behind the
 * caret.
 */
export class EdgeFileReferenceService extends FileReferenceService {
  private readonly withFiles: EdgeFileReferenceConfig['withFiles']
  private readonly maxResults: number
  private readonly maxEntries: number
  private readonly staleAfterMs: number
  private readonly now: () => number
  private readonly searches = new Map<Agent, WorkspaceSearch>()

  constructor(ctx: Context, config: EdgeFileReferenceConfig) {
    super(ctx)
    this.withFiles = read => config.withFiles(read)
    this.maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.staleAfterMs = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    this.now = config.now ?? Date.now
    for (const [name, value] of [['maxResults', this.maxResults], ['maxEntries', this.maxEntries], ['staleAfterMs', this.staleAfterMs]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`dsh-edge: file reference ${name} must be a positive safe integer`)
      }
    }
    // Every Edge agent mounts the upstream `read` tool, so the shared guidance
    // applies to every assembly instead of the per-agent check the local
    // provider performs.
    ctx.inject(['systemPrompt'], scope => {
      scope.systemPrompt.section({
        name: 'context:file-reference',
        order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
        text: FILE_REFERENCE_PROMPT,
      })
    })
    // As upstream, a tool may have changed the tree, so the index goes stale.
    // Every Edge session shares one workspace, so a tool result in any session
    // makes every session's index stale, not only its own.
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'tool/result') return
      for (const search of this.searches.values()) search.invalidate()
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.searches.get(agent)?.dispose()
      this.searches.delete(agent)
    })
    ctx.effect(() => () => {
      for (const search of this.searches.values()) search.dispose()
      this.searches.clear()
    }, 'edge file-reference indexes')
  }

  async list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    signal.throwIfAborted()
    // The session's current directory: `working_directory` can move it after the session began.
    const root = normalizeRoot(this.ctx.get('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd ?? DEFAULT_CWD)
    let search = this.searches.get(agent)
    if (search?.root !== root) {
      // As upstream, a new working directory discards the previous index.
      search?.dispose()
      search = new WorkspaceSearch(root, this.withFiles, this.maxResults, this.maxEntries, this.staleAfterMs, this.now)
      this.searches.set(agent, search)
    }
    return search.list(query, signal)
  }
}

/** One working directory's completion surface: live directory listings plus a shared recursive index. */
class WorkspaceSearch {
  /** Bumped by each invalidation; a settled index started below it is stale. */
  private invalidations = 0
  private settled: { entries: FileReferenceCandidate[], startedAt: number, readAt: number } | undefined
  private building: Promise<FileReferenceCandidate[]> | undefined
  private readonly lifetime = new AbortController()

  constructor(
    readonly root: string,
    private readonly withFiles: EdgeFileReferenceConfig['withFiles'],
    private readonly maxResults: number,
    private readonly maxEntries: number,
    private readonly staleAfterMs: number,
    private readonly now: () => number,
  ) {}

  async list(rawQuery: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    const scope = splitQuery(rawQuery)
    if (scope === undefined || this.lifetime.signal.aborted) return []
    if (scope.directory !== '' || scope.fragment === '') return this.listDirectory(scope, signal)
    const entries = await this.index(signal)
    signal.throwIfAborted()
    return rankCandidates(entries.filter(entry => visibleForBareQuery(entry.path, scope.fragment)), scope.fragment, this.maxResults)
  }

  invalidate(): void {
    this.invalidations += 1
  }

  dispose(): void {
    this.lifetime.abort(new Error('file reference index disposed'))
    this.settled = undefined
    this.building = undefined
  }

  /** The indexed paths, at most one invalidation behind the tree; only a first query waits. */
  private async index(signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    const settled = this.settled
    if (settled === undefined) return await abortable(this.build(), signal)
    if (settled.startedAt < this.invalidations || this.now() - settled.readAt >= this.staleAfterMs) this.build().catch(() => {})
    return settled.entries
  }

  private build(): Promise<FileReferenceCandidate[]> {
    if (this.building !== undefined) return this.building
    const startedAt = this.invalidations
    const readAt = this.now()
    const building = this.withFiles(files => this.scan(files)).then(entries => {
      if (this.building === building) {
        this.building = undefined
        if (!this.lifetime.signal.aborted) this.settled = { entries, startedAt, readAt }
      }
      return entries
    }, (error: unknown) => {
      if (this.building === building) this.building = undefined
      throw error
    })
    this.building = building
    return building
  }

  /**
   * Breadth-first, in name order, reading each directory up to the entries
   * still allowed. An unreadable root fails the build, so a transient failure
   * keeps the previous index; an unreadable subdirectory adds nothing.
   */
  private async scan(files: EdgeReferenceFiles): Promise<FileReferenceCandidate[]> {
    const indexed: FileReferenceCandidate[] = []
    const directories = [{ absolute: this.root, relative: '' }]
    for (let cursor = 0; cursor < directories.length && indexed.length < this.maxEntries; cursor += 1) {
      this.lifetime.signal.throwIfAborted()
      const directory = directories[cursor]!
      const limit = { limit: this.maxEntries - indexed.length }
      const entries = cursor === 0
        ? await files.readdir(directory.absolute, limit)
        : await files.readdir(directory.absolute, limit).catch(() => [])
      for (const entry of [...entries].sort((left, right) => compareText(left.name, right.name))) {
        const path = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`
        if (entry.isDirectory) {
          if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
          indexed.push({ path, kind: 'directory' })
          directories.push({ absolute: joinPath(directory.absolute, entry.name), relative: path })
        } else if (entry.isFile) {
          indexed.push({ path, kind: 'file' })
        }
        if (indexed.length >= this.maxEntries) break
      }
    }
    return indexed
  }

  private async listDirectory(scope: FileReferenceQueryScope, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    if (scope.directory.split('/').some(segment => EXCLUDED_DIRECTORIES.has(segment))) return []
    const directory = resolveWithin(this.root, scope.directory)
    if (directory === undefined) return []
    let entries: readonly EdgeReferenceEntry[]
    try {
      entries = await this.withFiles(files => files.readdir(directory))
    } catch {
      // A missing or unreadable directory is an empty completion surface, not
      // a failed request: the user is still typing the path.
      signal.throwIfAborted()
      return []
    }
    signal.throwIfAborted()
    const candidates: FileReferenceCandidate[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !scope.fragment.startsWith('.')) continue
      if (entry.isDirectory && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        candidates.push({ path: `${scope.directory}${entry.name}`, kind: 'directory' })
      } else if (entry.isFile) {
        candidates.push({ path: `${scope.directory}${entry.name}`, kind: 'file' })
      }
    }
    return rankCandidates(candidates, scope.fragment, this.maxResults)
  }
}

/** One parsed completion query. */
export interface FileReferenceQueryScope {
  /** Display prefix ending in `/`, or empty for the working directory. */
  directory: string
  /** Basename fragment being completed. */
  fragment: string
}

/** Split a query into the directory it lists and the fragment it ranks. */
export function splitQuery(rawQuery: string): FileReferenceQueryScope | undefined {
  const query = rawQuery.replaceAll('\\', '/')
  for (const character of query) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || character === '"') return undefined
  }
  const slash = query.lastIndexOf('/')
  if (slash < 0) return { directory: '', fragment: query }
  return { directory: query.slice(0, slash + 1), fragment: query.slice(slash + 1) }
}

/**
 * Resolve a display directory, relative to the working directory or absolute,
 * refusing anything outside the working directory, as upstream does.
 */
export function resolveWithin(root: string, displayDirectory: string): string | undefined {
  const base = normalizeRoot(root)
  const parts = displayDirectory.startsWith('/') ? [] : base.split('/').filter(Boolean)
  for (const segment of displayDirectory.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  const resolved = `/${parts.join('/')}`
  return resolved === base || base === '/' || resolved.startsWith(`${base}/`) ? resolved : undefined
}

/** Rank candidates for a query as upstream dsh-file-reference-local does. */
export function rankCandidates(
  candidates: readonly FileReferenceCandidate[],
  query: string,
  limit: number,
): FileReferenceCandidate[] {
  const ranked: { candidate: FileReferenceCandidate, score: number }[] = []
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query)
    if (score !== undefined) ranked.push({ candidate, score })
  }
  ranked.sort((left, right) =>
    right.score - left.score
    || kindRank(left.candidate.kind) - kindRank(right.candidate.kind)
    || (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length)
    || compareText(left.candidate.path, right.candidate.path))
  return ranked.slice(0, limit).map(entry => entry.candidate)
}

/** Exact, prefix, and substring name matches, then path substrings, then in-order subsequences. */
function scoreCandidate(candidate: FileReferenceCandidate, query: string): number | undefined {
  if (query === '') return 0
  const path = candidate.path.toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const needle = query.toLowerCase()
  const directoryBonus = candidate.kind === 'directory' ? 25 : 0
  if (name === needle) return 1_000 + directoryBonus
  if (name.startsWith(needle)) return 900 + directoryBonus
  if (name.includes(needle)) return 700 + directoryBonus
  if (path.includes(needle)) return 500 + directoryBonus
  const subsequence = subsequenceScore(path, needle)
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus
}

function subsequenceScore(target: string, query: string): number | undefined {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

/** A bare query skips paths under hidden names unless it asks for one. */
function visibleForBareQuery(path: string, query: string): boolean {
  if (query.startsWith('.') || query.includes('/.')) return true
  return !path.split('/').some(segment => segment.startsWith('.'))
}

function normalizeRoot(root: string): string {
  const trimmed = root.replace(/\/+$/u, '')
  return trimmed === '' ? '/' : trimmed
}

function joinPath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

function kindRank(kind: FileReferenceCandidate['kind']): number {
  return kind === 'directory' ? 0 : 1
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export default EdgeFileReferenceService
