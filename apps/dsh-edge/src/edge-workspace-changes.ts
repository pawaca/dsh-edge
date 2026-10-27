/**
 * Per-turn changed-file summaries for the Web changed-files card, served as
 * upstream's `workspaceChanges` service.
 *
 * Upstream `dsh-workspace-changes` diffs git snapshots of the working tree
 * and, for paths git does not cover, whole-file copies taken around each
 * file-tool edit. A Worker has no git, so this is upstream's documented
 * no-git mode: only `write`, `edit`, and mutating `str_replace_editor` calls
 * are recorded, and changes made only through shell commands or in the Linux
 * container are absent. The copies live in the workspace VFS under
 * {@link CAPTURE_ROOT}, named by the SHA-1 of their bytes, instead of the
 * Host's temporary directory, so a turn holds at most two file contents in
 * memory at once. Summaries live with their Session's recorder, as upstream's
 * do; the copies of a previous Durable Object activation are removed before
 * the first capture of the next.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  WorkspaceChangedFile,
  WorkspaceChanges,
  WorkspaceChangesSummary,
  WorkspaceDiffHunk,
  WorkspaceFileDiff,
} from '@deepseek-ai/dsh-workspace-changes/types'
import { structuredPatch } from 'diff'

/** VFS directory holding every recorder's captured copies, outside `/workspace`. */
export const CAPTURE_ROOT = '/.dsh/workspace-changes'

/** Upstream's defaults for the bounds this mode uses. */
export const WORKSPACE_CHANGES_DEFAULTS = { maxFiles: 500, maxFileBytes: 2 * 1024 * 1024, diffTimeoutMs: 100 } as const

/**
 * Lines a side may hold to be compared. Upstream bounds only bytes, but a
 * comparison allocates per line: under the 2 MiB cap, two sides of 20,000
 * lines peaked at about 22 MiB of heap when the comparison timed out and
 * degraded to whole-file replacement, 100,000 at 49 MiB, and a million short
 * lines at 265 MiB, past a Durable Object's 128 MiB. A side over it is listed
 * as oversized.
 */
export const MAX_COMPARE_LINES = 20_000

/** Count lines without splitting, so an oversized side allocates nothing more. */
function exceedsLines(text: string | null): boolean {
  if (text === null) return false
  let lines = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (++lines > MAX_COMPARE_LINES) return true
  }
  return lines + (text === '' || text.endsWith('\n') ? 0 : 1) > MAX_COMPARE_LINES
}

/** Bytes of a copy probed for a NUL byte, as upstream's `BINARY_PROBE_BYTES`. */
const BINARY_PROBE_BYTES = 8_000
const CONTEXT_LINES = 3
/** As upstream, files under the temporary directory are excluded unless inside the working directory. */
const TEMPORARY_ROOTS = ['/tmp']

/** The Computer workspace filesystem calls the recorder uses. */
export interface EdgeChangesFiles {
  stat(path: string): Promise<{ size: number, isFile: boolean }>
  readFile(path: string): Promise<ReadableStream<Uint8Array>>
  writeFile(path: string, content: Uint8Array): Promise<void>
  mkdir(path: string, options: { recursive: boolean }): Promise<void>
  rm(path: string, options: { recursive: boolean, force: boolean }): Promise<void>
}

export interface EdgeWorkspaceChangesConfig {
  /** Run one operation against the Durable Object's Computer workspace. */
  withFiles<T>(run: (files: EdgeChangesFiles) => Promise<T>): Promise<T>
  maxFiles?: number
  maxFileBytes?: number
  diffTimeoutMs?: number
}

/** One side of a file: missing, too large to read, or a stored copy. */
type Capture =
  | { kind: 'absent' }
  | { kind: 'oversized' }
  | { kind: 'file', file: string, binary: boolean }

type Sources = { refusal: 'binary' | 'oversized' } | { before: Capture, after: Capture }

interface TurnState {
  turn: number
  /** Captured turn-start sides by absolute VFS path. */
  captures: Map<string, Capture>
  lastToolResultSeq: number
  attemptedAfterSeq: number
  recordedAfterSeq: number
}

function freshState(turn: number): TurnState {
  return { turn, captures: new Map(), lastToolResultSeq: -1, attemptedAfterSeq: -1, recordedAfterSeq: -1 }
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

function relativeTo(root: string, path: string): string {
  return path === root ? '.' : path.slice(root.endsWith('/') ? root.length : root.length + 1)
}

/** Upstream's comparison of whole texts: every line terminated, three context lines, a timeout that degrades to whole-file replacement. */
export function compareText(before: string | null, after: string | null, timeoutMs: number):
{ hunks: WorkspaceDiffHunk[], coarse: boolean, added: number, deleted: number } {
  const terminated = (text: string) => text === '' || text.endsWith('\n') ? text : `${text}\n`
  const lines = (text: string) => text === '' ? [] : text.slice(0, -1).split('\n')
  const oldText = terminated(before ?? '')
  const newText = terminated(after ?? '')
  const patch = structuredPatch('', '', oldText, newText, undefined, undefined, { context: CONTEXT_LINES, timeout: timeoutMs })
  let hunks: WorkspaceDiffHunk[]
  let coarse = false
  if (patch === undefined) {
    coarse = true
    const oldLines = lines(oldText)
    const newLines = lines(newText)
    hunks = [{
      oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length,
      lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)],
    }]
  } else {
    hunks = patch.hunks.map(({ oldStart, oldLines, newStart, newLines, lines: body }) => ({ oldStart, oldLines, newStart, newLines, lines: body }))
  }
  let added = 0
  let deleted = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) deleted += 1
    }
  }
  return { hunks, coarse, added, deleted }
}

/** Read at most `maxBytes + 1` bytes, so a file that grows past the cap costs no more memory than the cap. */
async function readBounded(files: EdgeChangesFiles, path: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = (await files.readFile(path)).getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
      length += next.value.byteLength
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

async function sha1Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Serializes one Session's recording work and keeps its summaries, as
 * upstream's `TurnRecorder` does without git.
 */
class TurnRecorder {
  private chain: Promise<void> = Promise.resolve()
  private state = freshState(0)
  private readonly records = new Map<number, { summary: WorkspaceChangesSummary, sources: Sources[] }>()
  private readonly lifetime = new AbortController()
  /** Copies this recorder wrote, so a copy is written once. */
  private readonly written = new Set<string>()
  private readonly directory: string

  constructor(
    private readonly session: Session,
    private readonly cwd: string,
    private readonly env: Required<Omit<EdgeWorkspaceChangesConfig, 'withFiles'>> & {
      withFiles: EdgeWorkspaceChangesConfig['withFiles']
      prepare: () => Promise<void>
      warn: (message: string) => void
    },
  ) {
    this.directory = `${CAPTURE_ROOT}/${encodeURIComponent(session.id)}`
  }

  start(turn: number): void {
    this.state = freshState(turn)
  }

  capture(path: string): void {
    const state = this.state
    void this.enqueue(async () => {
      if (state.captures.has(path) || isInside(CAPTURE_ROOT, path)) return
      const capture = await this.captureFile(path)
      if (capture !== undefined) state.captures.set(path, capture)
    })
  }

  observe(event: SessionEvent): void {
    const state = this.state
    if ((event.data as { turn?: unknown }).turn === state.turn) state.lastToolResultSeq = event.seq
  }

  stopping(turn: number): Promise<void> {
    const state = this.state
    if (turn !== state.turn) return Promise.resolve()
    return this.enqueue(() => this.record(state))
  }

  end(turn: number): void {
    const state = this.state
    if (turn !== state.turn || state.attemptedAfterSeq >= state.lastToolResultSeq) return
    void this.enqueue(() => this.record(state))
  }

  settled(): Promise<void> {
    return this.chain
  }

  summary(seq: number): WorkspaceChangesSummary | undefined {
    return this.records.get(seq)?.summary
  }

  async diff(seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined> {
    const record = this.records.get(seq)
    const file = record?.summary.files[index]
    const sources = record?.sources[index]
    if (file === undefined || sources === undefined) return undefined
    const { path, display } = file
    if ('refusal' in sources) return { kind: sources.refusal, path, display }
    signal.throwIfAborted()
    try {
      const [before, after] = await this.env.withFiles(async files =>
        Promise.all([this.readText(files, sources.before), this.readText(files, sources.after)]))
      signal.throwIfAborted()
      const { hunks, coarse } = compareText(before, after, this.env.diffTimeoutMs)
      return { kind: 'text', path, display, before: before !== null, after: after !== null, hunks, coarse }
    } catch (error) {
      if (this.lifetime.signal.aborted) return undefined
      throw error
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.records.clear()
    await this.chain
    if (this.written.size > 0) {
      await this.env.withFiles(files => files.rm(this.directory, { recursive: true, force: true })).catch((error: unknown) => {
        this.env.warn(`workspace-changes: could not remove ${this.directory}: ${String(error)}`)
      })
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.lifetime.signal.aborted) return
      try {
        await task()
      } catch (error) {
        if (!this.lifetime.signal.aborted) this.env.warn(`workspace-changes: ${String(error)}`)
      }
    })
    this.chain = run
    return run
  }

  /** Store one path's current content as a content-addressed copy, or record it as absent or oversized. */
  private async captureFile(path: string): Promise<Capture | undefined> {
    await this.env.prepare()
    return this.env.withFiles(async (files) => {
      let info: { size: number, isFile: boolean }
      try {
        info = await files.stat(path)
      } catch (error) {
        if (isMissing(error)) return { kind: 'absent' as const }
        throw error
      }
      if (!info.isFile) return undefined
      if (info.size > this.env.maxFileBytes) return { kind: 'oversized' as const }
      const bytes = await readBounded(files, path, this.env.maxFileBytes)
      if (bytes === undefined) return { kind: 'oversized' as const }
      const file = `${this.directory}/${await sha1Hex(bytes)}`
      if (!this.written.has(file)) {
        await files.mkdir(this.directory, { recursive: true })
        await files.writeFile(file, bytes)
        this.written.add(file)
      }
      return { kind: 'file' as const, file, binary: bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) }
    })
  }

  private async readText(files: EdgeChangesFiles, capture: Capture): Promise<string | null> {
    if (capture.kind !== 'file') return null
    const bytes = await readBounded(files, capture.file, this.env.maxFileBytes)
    if (bytes === undefined) throw new Error(`captured copy ${capture.file} exceeds the size it was stored under`)
    return new TextDecoder().decode(bytes)
  }

  private async record(state: TurnState): Promise<void> {
    if (state.lastToolResultSeq < 0) return
    state.attemptedAfterSeq = state.lastToolResultSeq
    const listed: Array<{ file: WorkspaceChangedFile, sources: Sources }> = []
    for (const [path, before] of state.captures) {
      if (!isInside(this.cwd, path) && TEMPORARY_ROOTS.some(root => isInside(root, path))) continue
      const after = await this.captureFile(path)
      if (after === undefined || sameCapture(before, after)) continue
      listed.push(await this.compared(path, before, after))
    }
    listed.sort((a, b) => a.file.display < b.file.display ? -1 : a.file.display > b.file.display ? 1 : 0)
    if (listed.length === 0 && state.recordedAfterSeq < 0) return
    const event = this.session.append('workspace/changes', { turn: state.turn })
    const kept = listed.slice(0, this.env.maxFiles)
    this.records.set(event.seq, {
      summary: {
        turn: state.turn,
        cwd: this.cwd,
        files: kept.map(entry => entry.file),
        total: listed.length,
        added: listed.reduce((sum, entry) => sum + entry.file.added, 0),
        deleted: listed.reduce((sum, entry) => sum + entry.file.deleted, 0),
      },
      sources: kept.map(entry => entry.sources),
    })
    state.recordedAfterSeq = event.seq
  }

  private async compared(path: string, before: Capture, after: Capture): Promise<{ file: WorkspaceChangedFile, sources: Sources }> {
    const file = (counts: { added: number, deleted: number, binary?: true, oversized?: true }): WorkspaceChangedFile => ({
      path: isInside(this.cwd, path) ? relativeTo(this.cwd, path) : path,
      display: isInside(this.cwd, path) ? relativeTo(this.cwd, path) : path,
      ...counts,
    })
    if (before.kind === 'oversized' || after.kind === 'oversized') {
      return { file: file({ added: 0, deleted: 0, oversized: true }), sources: { refusal: 'oversized' } }
    }
    if ((before.kind === 'file' && before.binary) || (after.kind === 'file' && after.binary)) {
      return { file: file({ added: 0, deleted: 0, binary: true }), sources: { refusal: 'binary' } }
    }
    const [oldText, newText] = await this.env.withFiles(files => Promise.all([this.readText(files, before), this.readText(files, after)]))
    if (exceedsLines(oldText) || exceedsLines(newText)) {
      return { file: file({ added: 0, deleted: 0, oversized: true }), sources: { refusal: 'oversized' } }
    }
    const { added, deleted } = compareText(oldText, newText, this.env.diffTimeoutMs)
    return { file: file({ added, deleted }), sources: { before, after } }
  }
}

/** Two sides are the same when both are absent or both hold bytes that hash alike; an oversized side matches nothing. */
function sameCapture(a: Capture, b: Capture): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind
  return a.kind === 'file' && b.kind === 'file' && a.file === b.file
}

/** As upstream: top-level Sessions with a working directory; subagents are not recorded. */
function eligible(session: Session): string | undefined {
  const { cwd, origin, delegationDepth } = session.header as { cwd?: string, origin?: string, delegationDepth?: number }
  return origin === 'subagent' || (delegationDepth ?? 0) > 0 ? undefined : cwd
}

/**
 * Observe top-level turns, capture file-tool edits, announce change
 * summaries, and serve them with their comparisons as `workspaceChanges`.
 */
export function EdgeWorkspaceChanges(ctx: Context, config: EdgeWorkspaceChangesConfig): void {
  const bounds = { ...WORKSPACE_CHANGES_DEFAULTS, ...config }
  const recorders = new Map<Session, TurnRecorder>()
  const byId = new Map<SessionId, TurnRecorder>()
  const mutations = new WeakMap<object, TurnRecorder>()
  // Copies left by an earlier activation have no summaries to serve; remove
  // them once, before this activation's first capture.
  let prepared: Promise<void> | undefined
  const prepare = () => prepared ??= config.withFiles(files => files.rm(CAPTURE_ROOT, { recursive: true, force: true }))
    .catch((error: unknown) => { ctx.logger.warn(`workspace-changes: could not clear ${CAPTURE_ROOT}: ${String(error)}`) })
  const forget = (session: Session) => {
    const recorder = recorders.get(session)
    recorders.delete(session)
    byId.delete(session.id)
    return recorder?.dispose() ?? Promise.resolve()
  }
  ctx.effect(() => async () => {
    await Promise.all([...recorders.keys()].map(forget))
  })
  const service: WorkspaceChanges = {
    summary: (sessionId, seq) => byId.get(sessionId)?.summary(seq),
    diff: (sessionId, seq, index, signal) => byId.get(sessionId)?.diff(seq, index, signal) ?? Promise.resolve(undefined),
  }
  ctx.provide('workspaceChanges', service)
  const recorderFor = (session: Session, cwd: string) => {
    let recorder = recorders.get(session)
    if (recorder === undefined) {
      recorder = new TurnRecorder(session, cwd, {
        ...bounds,
        withFiles: run => config.withFiles(run),
        prepare,
        warn: message => { ctx.logger.warn(message) },
      })
      recorders.set(session, recorder)
      byId.set(session.id, recorder)
    }
    return recorder
  }
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'turn/start') {
      const cwd = eligible(session)
      if (cwd !== undefined) recorderFor(session, cwd).start((event.data as { turn: number }).turn)
      return
    }
    if (event.type === 'tool/result') recorders.get(session)?.observe(event)
    else if (event.type === 'turn/end') recorders.get(session)?.end((event.data as { turn: number }).turn)
  })
  ctx.on('session/disposed', (session: Session) => { void forget(session) })
  ctx.on('agent/turn-stopping', async ({ agent, turn }: { agent: { session: Session }, turn: number }) => {
    await recorders.get(agent.session)?.stopping(turn)
  })
  const capture = async (target: FsTarget, actor: object | undefined) => {
    const recorder = actor === undefined ? undefined : mutations.get(actor)
    if (recorder === undefined) return
    recorder.capture(ctx.fs.processPath(target))
    await recorder.settled()
  }
  ctx.on('fs/write-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }, { prepend: true })
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }, { prepend: true })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session
    const recorder = session === undefined ? undefined : recorders.get(session)
    if (recorder !== undefined) {
      mutations.set(exec, recorder)
      await recorder.settled()
    }
    return next()
  })
}
EdgeWorkspaceChanges.inject = ['fs']
