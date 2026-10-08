/**
 * Workspace skill files, as upstream dsh-skill-filesystem discovers them.
 *
 * Upstream reads skill roots with node:fs (or ctx.fs, which on the Edge exists
 * only during a turn) and keeps catalogs current with chokidar watches, which
 * Workers do not have. The Edge scans the same roots, formats, and frontmatter
 * through the Computer workspace, which answers inside and outside a turn. In
 * place of file watches, each discovery records a fingerprint of the roots
 * (entry names, sizes, and modification times, plus each bundle's SKILL.md);
 * before a turn's first step in a cwd with a cached catalog, the provider
 * rereads only that metadata and invalidates the catalog if it changed. A skill added,
 * edited, or removed applies from the next turn, an unchanged turn reads no
 * skill contents, and lookups between turns reuse one scan. Each root is read
 * up to MAX_ENTRIES_PER_ROOT entries, so a turn's check costs at most four
 * listings and that many stats per root whatever the roots hold, and a skill
 * file over MAX_SKILL_FILE_BYTES is skipped without being read.
 *
 * Roots and ranks follow upstream (lower wins a duplicate name):
 *   100 <projectRoot>/.dsh/skills    200 <projectRoot>/.agents/skills
 *   400 /.dsh/skills                 500 /.agents/skills
 * The project root is the nearest ancestor of the session cwd containing
 * `.git`, else the cwd. Workers have no home directory, so the user roots sit at
 * the workspace's filesystem root, as `/.dsh/AGENTS.md` does for instructions.
 * Skills stored through /api/skills keep rank 600 (edge-skill-provider.ts).
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillInvocationPolicy,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import { parse } from 'yaml'

/** The subset of the Computer workspace filesystem skill discovery reads. */
export interface EdgeSkillFiles {
  readdir(path: string, options?: { limit?: number }): Promise<readonly { name: string, isFile: boolean, isDirectory: boolean, size: number, mtime: number }[]>
  stat(path: string): Promise<{ size: number, mtime: number }>
  readFile(path: string, encoding: 'utf8'): Promise<string>
}

export interface EdgeWorkspaceSkillsConfig {
  /** Run one read against the Durable Object's Computer workspace. */
  withFiles<T>(read: (files: EdgeSkillFiles) => Promise<T>): Promise<T>
}

interface SkillRoot { path: string, rank: number, source: string, skipSystem: boolean }
interface SkillLocator { path: string, directory: string }

/** Upstream's provider name, so skill rows and invocations read the same as upstream. */
const PROVIDER_NAME = 'filesystem'
const DEFAULT_CWD = '/workspace'
/** Entries read from one skill root; a root holding more is cut off with a warning. */
export const MAX_ENTRIES_PER_ROOT = 100
/** Largest skill file read, as the /api/skills content limit; a larger one is skipped unread with a warning. */
export const MAX_SKILL_FILE_BYTES = 65_536
/** Cwds whose fingerprint is kept, as the skill registry's default catalog cache size; the least recently used is evicted. */
export const MAX_FINGERPRINTS = 128

export const name = 'edge-workspace-skills'
export const inject = ['skills']

export function apply(ctx: Context, config: EdgeWorkspaceSkillsConfig): void {
  ctx.effect(() => ctx.skills.registerProvider((control: SkillProviderControl): SkillProvider => {
    /** Hashed fingerprint of each cwd's roots when its catalog was last discovered, in least-recently-used order. */
    const fingerprints = new Map<string, string>()
    const remember = (cwd: string, value: string) => {
      fingerprints.delete(cwd)
      fingerprints.set(cwd, value)
      while (fingerprints.size > MAX_FINGERPRINTS) fingerprints.delete(fingerprints.keys().next().value!)
    }
    /** Sessions whose turn started and whose first step has not checked the roots yet. */
    const pending = new WeakSet<object>()
    const check = async (cwd: string, signal: AbortSignal | undefined) => {
      const known = fingerprints.get(cwd)
      if (known === undefined) return
      try {
        const current = await config.withFiles(files => fingerprint(files, cwd, signal))
        if (current === known || fingerprints.get(cwd) !== known) return
        fingerprints.delete(cwd)
        control.invalidate()
      } catch (error) {
        if (!control.signal.aborted && signal?.aborted !== true) ctx.logger.warn(`workspace skill roots for ${cwd} could not be checked: ${messageOf(error)}`)
      }
    }
    // Upstream refreshes on file events. The Edge checks the roots' metadata
    // before a turn's first step and invalidates only a catalog whose files
    // changed, so that turn already reads the current catalog.
    const stopTurns = ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') pending.add(session as object)
    })
    const stopSteps = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (pending.has(agent.session)) {
        pending.delete(agent.session)
        await check(normalize(agent.session.header.cwd ?? DEFAULT_CWD), signal)
      }
      return next()
    })
    const stop = () => { stopTurns(); stopSteps() }
    control.signal.addEventListener('abort', stop, { once: true })
    return {
      name: PROVIDER_NAME,
      list: (options: SkillLookupOptions) => config.withFiles(async files => {
        const cwd = normalize(options.cwd ?? DEFAULT_CWD)
        const scan = await discover(ctx, files, cwd, options.signal)
        remember(cwd, scan.fingerprint)
        return scan.candidates
      }),
      get: (candidate: SkillCandidate, options: SkillLookupOptions) => config.withFiles(files => load(ctx, files, candidate, options.signal)),
    }
  }))
}

/** The roots upstream scans for one cwd, deduplicated, in rank order. */
async function skillRoots(files: EdgeSkillFiles, cwd: string, signal: AbortSignal | undefined): Promise<SkillRoot[]> {
  const projectRoot = await findProjectRoot(files, cwd, signal)
  const roots: SkillRoot[] = [
    { path: join(projectRoot, '.dsh/skills'), rank: 100, source: 'project-dsh', skipSystem: false },
    { path: join(projectRoot, '.agents/skills'), rank: 200, source: 'project-agents', skipSystem: false },
    { path: '/.dsh/skills', rank: 400, source: 'user-dsh', skipSystem: true },
    { path: '/.agents/skills', rank: 500, source: 'user-agents', skipSystem: false },
  ]
  const seen = new Set<string>()
  return roots.filter(root => !seen.has(root.path) && seen.add(root.path))
}

/** Each root's skill entries, sorted, with the instruction file to read for each. */
async function rootEntries(files: EdgeSkillFiles, root: SkillRoot, signal: AbortSignal | undefined, warn: (message: string) => void = () => {}): Promise<{ locator: SkillLocator, size: number, mtime: number }[]> {
  const entries = []
  for (const entry of [...await listRoot(files, root.path, signal, warn)].sort((a, b) => a.name.localeCompare(b.name))) {
    if (root.skipSystem && entry.name === '.system') continue
    if (entry.isDirectory) {
      const locator = { path: join(root.path, entry.name, 'SKILL.md'), directory: join(root.path, entry.name) }
      signal?.throwIfAborted()
      let stat: { size: number, mtime: number } | undefined
      try {
        stat = await files.stat(locator.path)
      } catch (error) {
        if (!isAbsent(error)) throw error
      }
      if (stat !== undefined) entries.push({ locator, size: stat.size, mtime: stat.mtime })
    } else if (entry.isFile && entry.name.endsWith('.md')) {
      entries.push({ locator: { path: join(root.path, entry.name), directory: root.path }, size: entry.size, mtime: entry.mtime })
    }
  }
  return entries
}

/** Metadata-only fingerprint of a cwd's roots: which skill files exist, with their sizes and modification times. */
async function fingerprint(files: EdgeSkillFiles, cwd: string, signal: AbortSignal | undefined): Promise<string> {
  const parts: string[] = []
  for (const root of await skillRoots(files, cwd, signal)) {
    for (const entry of await rootEntries(files, root, signal)) parts.push(`${entry.locator.path}:${String(entry.size)}:${String(entry.mtime)}`)
  }
  return digest(parts.join('\n'))
}

/** A short FNV-1a digest of a fingerprint; a collision at worst keeps a catalog until the next change. */
function digest(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0
  }
  return `${a.toString(16)}:${b.toString(16)}:${String(text.length)}`
}

async function discover(ctx: Context, files: EdgeSkillFiles, cwd: string, signal: AbortSignal | undefined): Promise<{ candidates: SkillCandidate[], fingerprint: string }> {
  const candidates: SkillCandidate[] = []
  const parts: string[] = []
  for (const root of await skillRoots(files, cwd, signal)) {
    for (const { locator, size, mtime } of await rootEntries(files, root, signal, message => { ctx.logger.warn(message) })) {
      parts.push(`${locator.path}:${String(size)}:${String(mtime)}`)
      if (size > MAX_SKILL_FILE_BYTES) {
        ctx.logger.warn(`skill file ${locator.path} ignored: ${String(size)} bytes exceeds the ${String(MAX_SKILL_FILE_BYTES)}-byte limit`)
        continue
      }
      const parsed = await parseSkillFile(ctx, files, locator.path, signal)
      if (parsed === undefined) continue
      candidates.push({
        name: parsed.name,
        description: parsed.description,
        ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
        invocation: parsed.invocation,
        source: root.source,
        provider: PROVIDER_NAME,
        path: locator.path,
        resourceBase: { kind: 'directory', path: locator.directory },
        rank: root.rank,
        locator,
        ...parsed.metadata === undefined ? {} : { metadata: parsed.metadata },
      })
    }
  }
  return { candidates, fingerprint: digest(parts.join('\n')) }
}

async function load(ctx: Context, files: EdgeSkillFiles, candidate: SkillCandidate, signal: AbortSignal | undefined): Promise<SkillDefinition | undefined> {
  const locator = candidate.locator as SkillLocator
  signal?.throwIfAborted()
  try {
    if ((await files.stat(locator.path)).size > MAX_SKILL_FILE_BYTES) return undefined
  } catch (error) {
    if (isAbsent(error)) return undefined
    throw error
  }
  const parsed = await parseSkillFile(ctx, files, locator.path, signal)
  if (parsed === undefined) return undefined
  return {
    name: parsed.name,
    description: parsed.description,
    ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
    invocation: parsed.invocation,
    source: candidate.source,
    provider: PROVIDER_NAME,
    path: locator.path,
    resourceBase: { kind: 'directory', path: locator.directory },
    content: parsed.content,
    ...parsed.metadata === undefined ? {} : { metadata: parsed.metadata },
  }
}

async function listRoot(files: EdgeSkillFiles, path: string, signal: AbortSignal | undefined, warn: (message: string) => void) {
  signal?.throwIfAborted()
  try {
    const entries = await files.readdir(path, { limit: MAX_ENTRIES_PER_ROOT + 1 })
    if (entries.length <= MAX_ENTRIES_PER_ROOT) return entries
    warn(`skill root ${path} holds more than ${String(MAX_ENTRIES_PER_ROOT)} entries; only the first ${String(MAX_ENTRIES_PER_ROOT)} are read`)
    return entries.slice(0, MAX_ENTRIES_PER_ROOT)
  } catch (error) {
    if (isAbsent(error)) return []
    throw error
  }
}

async function findProjectRoot(files: EdgeSkillFiles, cwd: string, signal: AbortSignal | undefined): Promise<string> {
  let current = normalize(cwd)
  for (;;) {
    signal?.throwIfAborted()
    try {
      await files.stat(join(current, '.git'))
      return current
    } catch {
      // keep walking up
    }
    if (current === '/') return normalize(cwd)
    current = current.slice(0, current.lastIndexOf('/')) || '/'
  }
}

interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  metadata?: Readonly<Record<string, unknown>>
  content: string
}

/** Upstream's rules: YAML frontmatter with name and description; a malformed file is skipped with a warning. */
async function parseSkillFile(ctx: Context, files: EdgeSkillFiles, path: string, signal: AbortSignal | undefined): Promise<ParsedSkill | undefined> {
  signal?.throwIfAborted()
  let raw: string
  try {
    raw = await files.readFile(path, 'utf8')
  } catch (error) {
    if (isAbsent(error)) return undefined
    throw error
  }
  let parsed: { data: Record<string, unknown>, body: string } | undefined
  try {
    parsed = parseFrontmatter(raw)
  } catch (error) {
    ctx.logger.warn(`skill file ${path} ignored: invalid YAML frontmatter: ${messageOf(error)}`)
    return undefined
  }
  if (parsed === undefined) {
    ctx.logger.warn(`skill file ${path} ignored: missing YAML frontmatter`)
    return undefined
  }
  const name = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (name === undefined || description === undefined) {
    ctx.logger.warn(`skill file ${path} ignored: frontmatter requires name and description`)
    return undefined
  }
  if (!isSkillName(name)) {
    ctx.logger.warn(`skill file ${path} ignored: invalid skill name "${name}"`)
    return undefined
  }
  let invocation: SkillInvocationPolicy
  try {
    invocation = parseInvocationPolicy(parsed.data)
  } catch (error) {
    ctx.logger.warn(`skill file ${path} ignored: invalid invocation frontmatter: ${messageOf(error)}`)
    return undefined
  }
  const whenToUse = stringField(parsed.data, 'whenToUse')
  const metadata = parsed.data.metadata
  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    invocation,
    ...isRecord(metadata) ? { metadata } : {},
    content: parsed.body.trim(),
  }
}

export function parseFrontmatter(raw: string): { data: Record<string, unknown>, body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  for (;;) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      const data: unknown = parse(raw.slice(firstLineEnd + 1, lineStart))
      if (!isRecord(data)) return undefined
      return { data, body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1) }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

export function parseInvocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  for (const [legacy, canonical] of [['disableModelInvocation', 'disable-model-invocation'], ['modelInvocable', 'disable-model-invocation'], ['userInvocable', 'user-invocable']] as const) {
    if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
  return {
    modelInvocable: frontmatterBoolean(data, 'disable-model-invocation') !== true,
    userInvocable: frontmatterBoolean(data, 'user-invocable') !== false,
  }
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'FS_NOT_FOUND' || code === 'FS_NOT_DIRECTORY') return true
  return /no such file|not a directory|not found/iu.test(messageOf(error))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalize(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

function join(...parts: string[]): string {
  return normalize(parts.join('/'))
}
