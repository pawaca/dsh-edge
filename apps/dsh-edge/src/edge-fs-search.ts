/**
 * Upstream's `glob` and `grep` tools over the workspace VFS.
 *
 * `@deepseek-ai/dsh-tool-fs-search` runs the packaged ripgrep binary through
 * `ctx.subprocess`, which Workers cannot provide. This plugin registers the
 * same tool names, parameter and output schemas, result rendering, search-card
 * metadata, and formatted-result spill, and replaces only the ripgrep run:
 *
 * - files come from a walk of the workspace's directories (one `readdir`
 *   per directory, which also yields each file's size and mtime), skipping
 *   VCS metadata as upstream's argv does and, for `grep`, hidden entries as
 *   ripgrep's defaults do; `.gitignore` files are not applied;
 * - globs use minimatch with ripgrep's rule that a pattern with no `/`
 *   matches the basename at any depth;
 * - `grep` patterns compile with re2js, the linear-time RE2 engine just-bash
 *   already ships, so a pathological pattern cannot stall the Durable Object;
 * - every cap (entries walked, bytes read per file, matches and their text
 *   kept) is enforced while the work happens, not from an earlier snapshot.
 *
 * Helpers upstream exports are imported; the few it does not (match retention,
 * search-card metadata, the direct-call check) are copied from its 0.2.0-rc.2
 * `lib/index.js` and marked below.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ItemRetainer, type RetainedItems } from '@deepseek-ai/dsh-output-retention'
import {
  GLOB_MAX_RESULTS,
  GLOB_VCS_EXCLUDES,
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_META_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  SearchError,
  formatGrepMatches,
  formatGrepOutput,
  parseGlobArgs,
  parseGrepArgs,
  presentGlobCall,
  presentGlobResult,
  presentGrepCall,
  presentGrepResult,
  previewLine,
  toWorkdirRelative,
  trySaveFormattedResult,
  type GrepMatch,
} from '@deepseek-ai/dsh-tool-fs-search'
import { defineTool, type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { minimatch } from 'minimatch'
import { RE2JS } from 're2js'
import type { EdgeFileSystem, EdgeVfs } from './edge-filesystem.ts'

export const name = 'edge-fs-search'
export const inject = ['tools', 'systemPrompt', 'fs']

/**
 * Entries one search may walk (files and directories). Each listed entry is a
 * SQLite row the Durable Object reads, so the cap bounds both the time a
 * search holds the Durable Object and the rows it reads.
 */
export const SEARCH_MAX_ENTRIES = 20_000
/** Matches one `grep` may collect; upstream's equivalent is its 20 MB raw-output cap. */
export const GREP_MAX_COLLECTED_MATCHES = 20_000
/** `grep` stops reading a file past this many bytes and skips it, like a binary file. */
export const GREP_MAX_FILE_BYTES = 4 * 1024 * 1024
/**
 * Characters of matched lines one `grep` may hold, upstream's 20 MB raw-output
 * cap: long lines (minified bundles) must not exhaust the Durable Object's
 * memory before the match cap is reached.
 */
export const GREP_MAX_COLLECTED_CHARS = RAW_OUTPUT_MAX_BYTES

const VCS_NAMES = new Set(GLOB_VCS_EXCLUDES)
const skipVcs = (name: string) => VCS_NAMES.has(name)
const skipVcsAndHidden = (name: string) => VCS_NAMES.has(name) || name.startsWith('.')

interface WalkedFile {
  readonly path: string
  readonly mtime: number
}

interface SearchScope {
  readonly vfs: EdgeVfs
  readonly workdir: string
  readonly root: string
}

export function apply(ctx: Context): void {
  applyGlobTool(ctx)
  applyGrepTool(ctx)
}

function applyGlobTool(ctx: Context): void {
  // Upstream's section text, verbatim.
  ctx.systemPrompt.section({
    name: 'tool:glob',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GLOB'),
    text: ({ scope }) => ctx.tools.get('glob', scope) === undefined
      ? ''
      : 'Use the glob tool — not shell find — to discover files by path pattern.',
  })
  const tool: ToolDefinition = defineTool({
    name: 'glob',
    description: `Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. Returns up to ${String(GLOB_MAX_RESULTS)} paths in modification-time order; a larger result keeps the first paths and reports where the complete list was saved.`,
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.',
      },
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGlobPaths(value.paths) }],
      presentationMeta: (_args, value) => globSearchMeta({
        items: value.paths.slice(0, GLOB_MAX_RESULTS),
        truncated: value.paths.length > GLOB_MAX_RESULTS,
        seen: value.paths.length,
      }, SEARCH_META_MAX_BYTES),
    },
    async execute(args, exec) {
      const input = parseGlobArgs(args)
      assertValidGlob('glob', input.pattern)
      const scope = await searchScope(ctx, exec, input.path)
      const root = input.path === undefined ? '.' : toWorkdirRelative(input.path, scope.workdir)
      const files = await listFiles(scope, 'glob', skipVcs, exec.signal)
      const matched = files.filter(file => globMatches(input.pattern, relativeTo(file.path, scope.root)))
      // ripgrep's --sort=modified: oldest first, the path breaking ties.
      matched.sort((left, right) => left.mtime - right.mtime || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      return { root, paths: matched.map(file => toWorkdirRelative(file.path, scope.workdir)) }
    },
    presentCall: presentGlobCall,
    presentResult: presentGlobResult,
  })
  ctx.tools.register(tool)
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as { root: string; paths: string[] } | undefined
    if (value === undefined) return decision
    const paths = value.paths
    if (paths.length <= GLOB_MAX_RESULTS) return decision
    const spillRef = await trySaveFormattedResult(ctx, exec, 'glob-results.txt', paths.join('\n'))
    return {
      kind: 'accept',
      content: [{ type: 'text', text: renderGlobPaths(paths, spillRef) }],
      ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
    }
  })
}

function applyGrepTool(ctx: Context): void {
  // Upstream's section text, verbatim.
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: ({ scope }) => ctx.tools.get('grep', scope) === undefined
      ? ''
      : 'Use the grep tool — not shell grep or rg — to search file contents.'
        + (ctx.tools.get('read', scope) === undefined ? '' : ' Use read on a matched file when you need surrounding context.'),
  })
  const tool: ToolDefinition = defineTool({
    name: 'grep',
    description: `Search file contents with an RE2 regular expression (ripgrep's syntax, without lookaround or backreferences). Returns matching lines with line numbers, grouped by file. Skips hidden and binary files. Returns up to ${String(GREP_MAX_MATCHES)} matches; a larger result reports where the complete match list was saved.`,
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Regular expression to search for (RE2 syntax).',
      },
      path: {
        type: 'string',
        description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.',
      },
      include: {
        type: 'string',
        description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
      },
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatRetainedGrep(retainGrepMatches(value.matches)),
      }],
      presentationMeta: (_args, value) => grepSearchMeta(retainGrepMatches(value.matches), SEARCH_META_MAX_BYTES),
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args)
      let regex: RE2JS
      try {
        regex = RE2JS.compile(input.pattern)
      } catch (error) {
        throw new SearchError(`grep pattern rejected: ${error instanceof Error ? error.message : String(error)}`, 'SEARCH_INVALID_PATTERN')
      }
      if (input.include !== undefined) assertValidGlob('grep', input.include)
      const scope = await searchScope(ctx, exec, input.path)
      const files = await listFiles(scope, 'grep', skipVcsAndHidden, exec.signal)
      const matches: GrepMatch[] = []
      let collectedChars = 0
      for (const { path } of files) {
        throwIfAborted('grep', exec.signal)
        if (input.include !== undefined && path !== scope.root && !globMatches(input.include, relativeTo(path, scope.root))) continue
        const text = await readTextFile(scope.vfs, path)
        if (text === undefined) continue
        const display = toWorkdirRelative(path, scope.workdir)
        const lines = text.split('\n')
        if (lines.at(-1) === '') lines.pop()
        for (const [index, raw] of lines.entries()) {
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
          if (!regex.test(line)) continue
          collectedChars += line.length
          if (matches.length >= GREP_MAX_COLLECTED_MATCHES || collectedChars > GREP_MAX_COLLECTED_CHARS) {
            throw new SearchError(`grep matched more than ${String(GREP_MAX_COLLECTED_MATCHES)} lines or ${String(GREP_MAX_COLLECTED_CHARS)} characters; narrow pattern, path, or include`, 'SEARCH_RAW_OUTPUT_OVERFLOW')
          }
          matches.push({ path: display, lineNumber: index + 1, line })
        }
      }
      return { matches }
    },
    presentCall: presentGrepCall,
    presentResult: presentGrepResult,
  })
  ctx.tools.register(tool)
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as { matches: GrepMatch[] } | undefined
    if (value === undefined) return decision
    const matches = value.matches
    if (matches.length <= GREP_MAX_MATCHES) return decision
    const previewedAll = matches.map(match => ({ ...match, line: previewLine(match.line, GREP_MAX_LINE_BYTES) }))
    const spillRef = await trySaveFormattedResult(ctx, exec, 'grep-results.txt',
      `Found ${String(matches.length)} ${matchNoun(matches.length)}\n\n${formatGrepMatches(previewedAll)}`)
    return {
      kind: 'accept',
      content: [{ type: 'text', text: formatRetainedGrep(retainGrepMatches(matches), spillRef) }],
      ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
    }
  })
}

/** Resolve the search root against the session's working directory. */
async function searchScope(ctx: Context, exec: ToolExecution, path: string | undefined): Promise<SearchScope> {
  const fs = ctx.fs as unknown as EdgeFileSystem
  const { vfs, cwd } = fs.searchScope()
  const workdir = exec.agent?.session.header.cwd ?? cwd
  const target = await fs.resolve(path ?? workdir, { cwd: workdir, signal: exec.signal })
  return { vfs, workdir, root: String(target.targetKey) }
}

/**
 * Every file under the search root (or the root itself when it is a file),
 * depth-first in name order, with the mtime its directory listing reports.
 * A skipped directory is not entered. Each listing asks for at most the
 * remaining budget plus one entry, so the walk fails once it would pass
 * {@link SEARCH_MAX_ENTRIES} without reading further rows, and it stops at
 * the next listing once the call is cancelled or times out.
 */
async function listFiles(
  scope: SearchScope,
  toolName: string,
  skip: (name: string) => boolean,
  signal: AbortSignal,
): Promise<WalkedFile[]> {
  let info
  try {
    info = await scope.vfs.stat(scope.root)
  } catch (error) {
    throw new SearchError(`${toolName} path not found: ${scope.root}`, 'SEARCH_FAILED', { cause: error })
  }
  if (!info.isDirectory) return [{ path: scope.root, mtime: info.mtime }]
  const files: WalkedFile[] = []
  let listed = 0
  const visit = async (directory: string): Promise<void> => {
    throwIfAborted(toolName, signal)
    const entries = await scope.vfs.readdir(directory, { limit: SEARCH_MAX_ENTRIES - listed + 1 })
    throwIfAborted(toolName, signal)
    listed += entries.length
    if (listed > SEARCH_MAX_ENTRIES) {
      throw new SearchError(`${toolName} would walk more than ${String(SEARCH_MAX_ENTRIES)} entries under ${scope.root}; narrow path`, 'SEARCH_RAW_OUTPUT_OVERFLOW')
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      if (skip(entry.name)) continue
      const path = directory === '/' ? `/${entry.name}` : `${directory}/${entry.name}`
      if (entry.isDirectory) await visit(path)
      else if (entry.isFile) files.push({ path, mtime: entry.mtime })
    }
  }
  await visit(scope.root)
  return files
}

/**
 * A file's UTF-8 text, or undefined when it is binary (contains NUL) or its
 * bytes pass {@link GREP_MAX_FILE_BYTES}: the read stops there, so a file
 * replaced by a larger one after the walk is still never loaded whole.
 */
async function readTextFile(vfs: EdgeVfs, path: string): Promise<string | undefined> {
  const reader = (await vfs.readFile(path)).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > GREP_MAX_FILE_BYTES || value.includes(0)) {
        await reader.cancel()
        return undefined
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function throwIfAborted(toolName: string, signal: AbortSignal): void {
  if (signal.aborted) throw new SearchError(`${toolName} aborted`, 'SEARCH_ABORTED', { cause: signal.reason })
}

function relativeTo(path: string, root: string): string {
  if (path === root) return path.slice(path.lastIndexOf('/') + 1)
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : root === '/' ? path.slice(1) : path
}

/**
 * Reject the glob syntax ripgrep 15's globset refuses (an unclosed character
 * class, a reversed range, an unclosed or unopened alternate group, a
 * dangling escape), which minimatch would otherwise read as literal text or
 * an empty class and match nothing. Nested alternates are valid in ripgrep 15.
 */
function assertValidGlob(toolName: string, pattern: string): void {
  const reject = (reason: string): never => {
    throw new SearchError(`${toolName} pattern rejected: error parsing glob '${pattern}': ${reason}`, 'SEARCH_INVALID_PATTERN')
  }
  let groupDepth = 0
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '\\') {
      if (index + 1 >= pattern.length) reject('dangling \'\\\'')
      index++
    } else if (char === '[') {
      index = classEnd(pattern, index, reject)
    } else if (char === '{') {
      groupDepth++
    } else if (char === '}') {
      if (groupDepth === 0) reject('unopened alternate group; missing \'{\'')
      groupDepth--
    }
  }
  if (groupDepth > 0) reject('unclosed alternate group; missing \'}\'')
}

/** The index of the `]` closing the class opened at `start`, rejecting reversed ranges. */
function classEnd(pattern: string, start: number, reject: (reason: string) => never): number {
  let index = start + 1
  if (pattern[index] === '!' || pattern[index] === '^') index++
  // A `]` right after the opening (or negation) is a literal member.
  let first = true
  while (index < pattern.length) {
    const char = pattern[index]!
    if (char === ']' && !first) return index
    first = false
    const upper = pattern[index + 2]
    if (pattern[index + 1] === '-' && upper !== undefined && upper !== ']') {
      if (upper.codePointAt(0)! < char.codePointAt(0)!) reject(`invalid range; '${char}' > '${upper}'`)
      index += 3
    } else {
      index++
    }
  }
  return reject('unclosed character class; missing \']\'')
}

/** ripgrep glob rules: hidden names match, and a pattern with no `/` matches the basename at any depth. */
function globMatches(pattern: string, relativePath: string): boolean {
  return minimatch(relativePath, pattern, { dot: true, matchBase: !pattern.includes('/') })
}

function renderGlobPaths(paths: readonly string[], spillRef?: { locator: string; retrievalHint: string }): string {
  if (paths.length === 0) return 'No files found'
  if (paths.length <= GLOB_MAX_RESULTS) return paths.join('\n')
  // Copied from upstream formatGlobPage (not exported); upstream's composition
  // sets sampleOverCapGlobResults: false, so the page keeps the oldest paths.
  const recovery = spillRef === undefined
    ? 'The complete result could not be saved; narrow pattern or path to see more.'
    : `Full sorted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
  return `${paths.slice(0, GLOB_MAX_RESULTS).join('\n')}\n\n(Showing ${String(GLOB_MAX_RESULTS)} of ${String(paths.length)} paths. ${recovery})`
}

// ---- Copied from @deepseek-ai/dsh-tool-fs-search 0.2.0-rc.2 (not exported) ----

function retainGrepMatches(matches: readonly GrepMatch[]): RetainedItems<GrepMatch> {
  const retainer = new ItemRetainer<GrepMatch>({ kind: 'head', maxItems: GREP_MAX_MATCHES })
  for (const match of matches) retainer.push({ ...match, line: previewLine(match.line, GREP_MAX_LINE_BYTES) })
  return retainer.finish()
}

function matchNoun(count: number): string {
  return count === 1 ? 'match' : 'matches'
}

function formatRetainedGrep(retained: RetainedItems<GrepMatch>, spillRef?: Parameters<typeof formatGrepOutput>[1]): string {
  if (retained.seen === 0) return 'No matches found'
  return formatGrepOutput(retained, spillRef)
}

type SearchMeta =
  | { shape: 'matches'; files: Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }>; truncated: boolean; total: number }
  | { shape: 'paths'; paths: string[]; truncated: boolean; total: number }

function groupMatchesByFile(matches: readonly GrepMatch[]): Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }> {
  const byFile = new Map<string, Array<{ lineNumber: number; line: string }>>()
  for (const match of matches) {
    const entry = { lineNumber: match.lineNumber, line: match.line }
    const group = byFile.get(match.path)
    if (group === undefined) byFile.set(match.path, [entry])
    else group.push(entry)
  }
  return Array.from(byFile, ([path, fileMatches]) => ({ path, matches: fileMatches }))
}

function metaBytes(meta: SearchMeta): number {
  return new TextEncoder().encode(JSON.stringify(meta)).byteLength
}

function capMetaBytes(meta: SearchMeta, maxMetaBytes: number): SearchMeta {
  if (metaBytes(meta) <= maxMetaBytes) return meta
  if (meta.shape === 'matches') {
    // Edge change: upstream stops at one file, which can stay far over the cap
    // when every match is in that file; trim its matches too.
    const files = meta.files.map(file => ({ ...file, matches: [...file.matches] }))
    while (metaBytes({ ...meta, files, truncated: true }) > maxMetaBytes) {
      if (files.length > 1) files.pop()
      else if (files[0] !== undefined && files[0].matches.length > 1) files[0].matches.pop()
      else break
    }
    return { ...meta, files, truncated: true }
  }
  const paths = [...meta.paths]
  while (paths.length > 1 && metaBytes({ ...meta, paths, truncated: true }) > maxMetaBytes) paths.pop()
  return { ...meta, paths, truncated: true }
}

function grepSearchMeta(retained: RetainedItems<GrepMatch>, maxMetaBytes: number): SearchMeta {
  return capMetaBytes({ shape: 'matches', files: groupMatchesByFile(retained.items), truncated: retained.truncated, total: retained.seen }, maxMetaBytes)
}

function globSearchMeta(retained: { items: string[]; truncated: boolean; seen: number }, maxMetaBytes: number): SearchMeta {
  return capMetaBytes({ shape: 'paths', paths: retained.items, truncated: retained.truncated, total: retained.seen }, maxMetaBytes)
}

function acceptedDirectCallValue(
  ctx: Context,
  tool: ToolDefinition,
  exec: ToolExecution,
  result: { isError?: boolean; value?: unknown },
  decision: { kind: string; content?: unknown },
): unknown {
  if (decision.kind !== 'accept' || decision.content !== undefined || Object.hasOwn(decision, 'value')
    || exec.parent !== undefined || exec.name !== tool.name || result.isError === true
    || ctx.tools.get(exec.name, exec.agent) !== tool) return undefined
  return result.value
}
