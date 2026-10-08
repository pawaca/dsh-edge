/**
 * Workspace skill files, as upstream dsh-skill-filesystem discovers them.
 *
 * Upstream reads skill roots with node:fs (or ctx.fs, which on the Edge exists
 * only during a turn) and keeps catalogs current with chokidar watches, which
 * Workers do not have. The Edge scans the same roots, formats, and frontmatter
 * through the Computer workspace, which answers inside and outside a turn, and
 * refreshes the catalog when a turn starts: a skill added, edited, or removed
 * applies from the next turn, and lookups between turns reuse one scan.
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
  readdir(path: string): Promise<readonly { name: string, isFile: boolean, isDirectory: boolean }[]>
  stat(path: string): Promise<unknown>
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

export const name = 'edge-workspace-skills'
export const inject = ['skills']

export function apply(ctx: Context, config: EdgeWorkspaceSkillsConfig): void {
  ctx.effect(() => ctx.skills.registerProvider((control: SkillProviderControl): SkillProvider => {
    // Upstream refreshes on file events; the Edge refreshes once per turn.
    const stop = ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/start') control.invalidate()
    })
    control.signal.addEventListener('abort', stop, { once: true })
    return {
      name: PROVIDER_NAME,
      list: (options: SkillLookupOptions) => config.withFiles(files => discover(ctx, files, options.cwd ?? DEFAULT_CWD)),
      get: (candidate: SkillCandidate) => config.withFiles(files => load(ctx, files, candidate)),
    }
  }))
}

async function discover(ctx: Context, files: EdgeSkillFiles, cwd: string): Promise<SkillCandidate[]> {
  const projectRoot = await findProjectRoot(files, cwd)
  const roots: SkillRoot[] = [
    { path: join(projectRoot, '.dsh/skills'), rank: 100, source: 'project-dsh', skipSystem: false },
    { path: join(projectRoot, '.agents/skills'), rank: 200, source: 'project-agents', skipSystem: false },
    { path: '/.dsh/skills', rank: 400, source: 'user-dsh', skipSystem: true },
    { path: '/.agents/skills', rank: 500, source: 'user-agents', skipSystem: false },
  ]
  const candidates: SkillCandidate[] = []
  const seenRoots = new Set<string>()
  for (const root of roots) {
    if (seenRoots.has(root.path)) continue
    seenRoots.add(root.path)
    for (const entry of [...await listRoot(files, root.path)].sort((a, b) => a.name.localeCompare(b.name))) {
      if (root.skipSystem && entry.name === '.system') continue
      const locator: SkillLocator | undefined = entry.isDirectory
        ? { path: join(root.path, entry.name, 'SKILL.md'), directory: join(root.path, entry.name) }
        : entry.isFile && entry.name.endsWith('.md') ? { path: join(root.path, entry.name), directory: root.path } : undefined
      if (locator === undefined) continue
      const parsed = await parseSkillFile(ctx, files, locator.path)
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
  return candidates
}

async function load(ctx: Context, files: EdgeSkillFiles, candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
  const locator = candidate.locator as SkillLocator
  const parsed = await parseSkillFile(ctx, files, locator.path)
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

async function listRoot(files: EdgeSkillFiles, path: string) {
  try {
    return await files.readdir(path)
  } catch (error) {
    if (isAbsent(error)) return []
    throw error
  }
}

async function findProjectRoot(files: EdgeSkillFiles, cwd: string): Promise<string> {
  let current = normalize(cwd)
  for (;;) {
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
async function parseSkillFile(ctx: Context, files: EdgeSkillFiles, path: string): Promise<ParsedSkill | undefined> {
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
