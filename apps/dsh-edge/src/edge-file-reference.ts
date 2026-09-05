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
  readdir(path: string): Promise<readonly EdgeReferenceEntry[]>
}

export interface EdgeFileReferenceConfig {
  /** Run one discovery read against the Durable Object's Computer workspace. */
  withFiles<T>(read: (files: EdgeReferenceFiles) => Promise<T>): Promise<T>
  /** Maximum candidates returned for one query. */
  maxResults?: number
}

const DEFAULT_MAX_RESULTS = 20
const DEFAULT_CWD = '/workspace'

/**
 * Directory-scoped `@file` completion over the Computer VFS.
 *
 * The upstream local provider walks a native filesystem into a fuzzy index;
 * on Workers every directory read is a Computer RPC, so the Edge answers each
 * query from exactly one listing: the directory the query names (the session
 * working directory for a bare fragment). Users descend with a trailing slash,
 * which is the grammar the shared reference UI already drives.
 */
export class EdgeFileReferenceService extends FileReferenceService {
  private readonly withFiles: EdgeFileReferenceConfig['withFiles']
  private readonly maxResults: number

  constructor(ctx: Context, config: EdgeFileReferenceConfig) {
    super(ctx)
    this.withFiles = read => config.withFiles(read)
    this.maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS
    if (!Number.isSafeInteger(this.maxResults) || this.maxResults <= 0) {
      throw new Error('dsh-edge: file reference maxResults must be a positive safe integer')
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
  }

  async list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    signal.throwIfAborted()
    const root = agent.session.header.cwd ?? DEFAULT_CWD
    const scope = splitQuery(query)
    if (scope === undefined) return []
    const directory = resolveWithin(root, scope.directory)
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
    return rankCandidates(entries, scope, this.maxResults)
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

/** Resolve a display directory under the working directory, refusing escapes. */
export function resolveWithin(root: string, displayDirectory: string): string | undefined {
  const parts: string[] = []
  for (const segment of displayDirectory.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  if (parts.length === 0) return base === '' ? '/' : base
  return `${base}/${parts.join('/')}`
}

/** Rank one directory listing for a fragment the way the upstream local provider ranks a scoped query. */
export function rankCandidates(
  entries: readonly EdgeReferenceEntry[],
  scope: FileReferenceQueryScope,
  limit: number,
): FileReferenceCandidate[] {
  const needle = scope.fragment.toLowerCase()
  const ranked: { candidate: FileReferenceCandidate; score: number }[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') && !scope.fragment.startsWith('.')) continue
    const kind = entry.isDirectory ? 'directory' : entry.isFile ? 'file' : undefined
    if (kind === undefined) continue
    const score = scoreName(entry.name.toLowerCase(), needle, kind)
    if (score === undefined) continue
    ranked.push({ candidate: { path: `${scope.directory}${entry.name}`, kind }, score })
  }
  ranked.sort((left, right) =>
    right.score - left.score
    || kindRank(left.candidate.kind) - kindRank(right.candidate.kind)
    || compareText(left.candidate.path, right.candidate.path))
  return ranked.slice(0, limit).map(entry => entry.candidate)
}

function scoreName(
  name: string,
  needle: string,
  kind: FileReferenceCandidate['kind'],
): number | undefined {
  const directoryBonus = kind === 'directory' ? 25 : 0
  if (needle === '') return directoryBonus
  if (name === needle) return 1_000 + directoryBonus
  if (name.startsWith(needle)) return 900 + directoryBonus
  if (name.includes(needle)) return 700 + directoryBonus
  return undefined
}

function kindRank(kind: FileReferenceCandidate['kind']): number {
  return kind === 'directory' ? 0 : 1
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export default EdgeFileReferenceService
