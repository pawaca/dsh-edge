/** Validation and execution helpers for the Cloudflare Computer workspace. */

import { getWorkspace } from '@cloudflare/computer'
import type { EdgeShellResult } from './agent.ts'
import { DIRECT_SHELL_OUTPUT_TRUNCATED } from './direct-shell-protocol.ts'
import { StreamCapture, type ShellSpillTarget, type ShellStream } from './edge-shell-output.ts'
import { EdgeExecutionId } from './protocol.ts'

const MAX_COMMAND_BYTES = 16_384
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_MAX_COMMAND_TIMEOUT_MS = 120_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
/**
 * How long a cancelled command gets to exit after SIGINT. A Worker shell kill
 * is a separate RPC that can reach a different isolate than the running
 * command, so it may not stop it; the turn then stops waiting instead.
 */
export const CANCELLED_COMMAND_GRACE_MS = 2_000
const textEncoder = new TextEncoder()

export const MAX_TEXT_FILE_BYTES = 1_048_576

/** Invalid workspace input reported to an HTTP caller. */
export class EdgeWorkspaceRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** Cloudflare Computer client returned by the workspace binding. */
export type EdgeWorkspace = Awaited<ReturnType<typeof getWorkspace>>

/** Validated deployment policy applied to every Computer shell execution. */
export interface EdgeCommandTimeoutPolicy {
  defaultTimeoutMs: number
  maxTimeoutMs: number
}

/** Resolve the default and caller-selectable ceiling for Computer commands. */
export function resolveEdgeCommandTimeoutPolicy(
  defaultRaw?: string,
  maxRaw?: string,
): EdgeCommandTimeoutPolicy {
  const maxTimeoutMs = resolveDeploymentTimeout(
    maxRaw,
    DEFAULT_MAX_COMMAND_TIMEOUT_MS,
    'DSH_EDGE_MAX_COMMAND_TIMEOUT_MS',
  )
  const defaultTimeoutMs = resolveDeploymentTimeout(
    defaultRaw,
    DEFAULT_COMMAND_TIMEOUT_MS,
    'DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS',
  )
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new Error(
      'dsh-edge: DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS must be no greater than '
      + 'DSH_EDGE_MAX_COMMAND_TIMEOUT_MS',
    )
  }
  return { defaultTimeoutMs, maxTimeoutMs }
}

interface EdgeWorkspaceFiles {
  stat(path: string): Promise<{ size: number }>
  readFile(path: string): Promise<ReadableStream<Uint8Array>>
}

/** Refuse an oversized VFS entry before and while consuming its opened byte stream. */
export async function readBoundedWorkspaceFile(
  files: EdgeWorkspaceFiles,
  path: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const entry = await files.stat(path)
  if (entry.size > MAX_TEXT_FILE_BYTES) {
    throw new EdgeWorkspaceRequestError(413, 'Text files are limited to 1 MiB in the Edge API.')
  }
  const stream = await files.readFile(path)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      byteLength += next.value.byteLength
      if (byteLength > MAX_TEXT_FILE_BYTES) {
        chunks.length = 0
        await reader.cancel().catch(() => undefined)
        throw new EdgeWorkspaceRequestError(
          413,
          'Text files are limited to 1 MiB in the Edge API.',
        )
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const contents = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    contents.set(chunk, offset)
    offset += chunk.byteLength
  }
  return contents
}

/** Validate an absolute path inside the persistent workspace root. */
export function requireWorkspacePath(value: unknown): string {
  if (
    typeof value !== 'string'
    || (value !== '/workspace' && !value.startsWith('/workspace/'))
  ) {
    throw new EdgeWorkspaceRequestError(400, 'A path below /workspace/ is required.')
  }
  if (value.includes('\0') || value.split('/').includes('..')) {
    throw new EdgeWorkspaceRequestError(
      400,
      'Workspace paths cannot contain NUL bytes or parent traversal.',
    )
  }
  return value
}

/** Validate a just-bash command accepted from HTTP or a model tool call. */
export function requireCommand(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EdgeWorkspaceRequestError(400, 'A non-empty command is required.')
  }
  if (textEncoder.encode(value).byteLength > MAX_COMMAND_BYTES) {
    throw new EdgeWorkspaceRequestError(413, 'Commands are limited to 16 KiB.')
  }
  return value
}

/** Execute one bounded just-bash command and normalize its result. */
/** The command's timeout, validated against the deployment policy before anything runs. */
export function resolveCommandTimeoutMs(timeoutPolicy: EdgeCommandTimeoutPolicy, timeoutMs?: number): number {
  const effectiveTimeoutMs = timeoutMs ?? timeoutPolicy.defaultTimeoutMs
  if (!Number.isInteger(effectiveTimeoutMs)
    || effectiveTimeoutMs <= 0
    || effectiveTimeoutMs > timeoutPolicy.maxTimeoutMs) {
    throw new EdgeWorkspaceRequestError(
      400,
      `timeoutMs must be a positive integer no greater than ${timeoutPolicy.maxTimeoutMs}.`,
    )
  }
  return effectiveTimeoutMs
}

export async function executeWorkspaceCommand(
  workspace: EdgeWorkspace,
  command: string,
  cwd: string,
  timeoutPolicy: EdgeCommandTimeoutPolicy,
  timeoutMs?: number,
  signal?: AbortSignal,
  backend?: string,
  /** Skip creating cwd when the caller already did (Computer's mkdir always writes). */
  cwdReady = false,
  /**
   * Called when the result is `detached`: `settled` resolves once the command
   * is known to be over, or at its own timeout. A caller that admitted the
   * command holds its slot until then.
   */
  onDetached?: (settled: Promise<void>) => void,
  /** Extra environment variables for the command (upstream's `DSH_*` shell env). */
  env?: Readonly<Record<string, string>>,
): Promise<EdgeShellResult> {
  const effectiveTimeoutMs = resolveCommandTimeoutMs(timeoutPolicy, timeoutMs)
  signal?.throwIfAborted()
  if (!cwdReady) await workspace.fs.mkdir(cwd, { recursive: true })
  signal?.throwIfAborted()
  const deadline = commandDeadline(effectiveTimeoutMs)
  // Cancellation starts a grace period before the execution exists: a Worker
  // shell answers `exec` only after the command has finished.
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let stopWaiting!: () => void
  const graceExpired = new Promise<typeof GRACE_EXPIRED>((resolve) => { stopWaiting = () => resolve(GRACE_EXPIRED) })
  let interruptionRequested = false
  const current: { execution?: Awaited<ReturnType<EdgeWorkspace['runtime']['exec']>> } = {}
  const interrupt = (): Promise<void> => {
    interruptionRequested = true
    return current.execution?.kill('SIGINT').catch(() => undefined) ?? Promise.resolve()
  }
  const abort = (): void => {
    void interrupt()
    graceTimer ??= setTimeout(stopWaiting, CANCELLED_COMMAND_GRACE_MS)
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted === true) abort()
  const starting = workspace.runtime.exec(command, {
    cwd,
    timeoutMs: effectiveTimeoutMs,
    ...backend === undefined ? {} : { backend },
    ...env === undefined ? {} : { env: { ...env } },
  })
  let started: Awaited<typeof starting> | typeof GRACE_EXPIRED
  try {
    started = await Promise.race([starting, graceExpired])
  } catch (error) {
    clearTimeout(graceTimer)
    signal?.removeEventListener('abort', abort)
    throw error
  }
  if (started === GRACE_EXPIRED) {
    // Still starting or running after its interrupt: stop waiting. A late
    // answer only proves the command started (a container) or ended (a Worker
    // shell), so interrupt it and treat it as over once its stream ends.
    signal?.removeEventListener('abort', abort)
    const exited = starting.then(async (late) => {
      try {
        void late.kill('SIGINT').catch(() => undefined)
        const reader = late.getReader()
        try {
          while (!(await reader.read()).done) { /* drain to the exit event */ }
        } finally {
          reader.releaseLock()
        }
      } catch {
        // An unreadable late stream leaves the command's own timeout as the bound.
        await deadline.expired()
      } finally {
        late[Symbol.dispose]?.()
      }
    }, () => undefined)
    onDetached?.(Promise.race([exited, deadline.expired()]))
    return {
      executionId: EdgeExecutionId(`detached-${crypto.randomUUID()}`),
      status: 'cancelled',
      timedOut: false,
      exitCode: -1,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      detached: true,
    }
  }
  using running = started
  current.execution = running
  if (interruptionRequested) void interrupt()
  let detached = false
  // Each stream keeps its tail in memory and spills past it, while the command
  // runs on (upstream bash-local's behavior); the spill lands next to the
  // other spills, which the daily sweep deletes after 30 days.
  const spillTarget = (stream: ShellStream): ShellSpillTarget => {
    const path = `${SHELL_SPILL_DIRECTORY}/bash-${running.id}.${stream}.txt`
    return {
      path,
      write: async (body) => {
        try {
          await workspace.fs.mkdir(SHELL_SPILL_DIRECTORY, { recursive: true })
        } catch (error) {
          await body.cancel(error)
          throw error
        }
        await workspace.fs.writeFile(path, body)
      },
    }
  }
  const stdout = new StreamCapture(() => spillTarget('stdout'))
  const stderr = new StreamCapture(() => spillTarget('stderr'))
  let stoppedAtLightLimit = false
  // Armed on the first output event: only a spill wait can outlast the deadline.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let stopAtDeadline!: () => void
  const deadlinePassed = new Promise<typeof DEADLINE_PASSED>((resolve) => { stopAtDeadline = () => resolve(DEADLINE_PASSED) })
  let exitCode = -1
  const reader = running.getReader()
  try {
    while (true) {
      const next = await Promise.race([reader.read(), graceExpired])
      if (next === GRACE_EXPIRED) {
        // The command outlived its interrupt: stop waiting for it.
        detached = true
        void reader.cancel().catch(() => undefined)
        break
      }
      if (next.done) break
      const event = next.value
      if (event.name === 'exit') {
        deadline.complete()
        exitCode = event.code
        // The lightweight shell buffers output and stops at its own bound.
        if (event.result === DIRECT_SHELL_OUTPUT_TRUNCATED) {
          stoppedAtLightLimit = true
          interruptionRequested = true
        }
        continue
      }
      // Waits while the spill writer is full, so the next event is read only
      // once storage has caught up; a cancelled command's grace still bounds it.
      // The command's own deadline bounds it too, for callers that never
      // cancel (the HTTP exec route).
      deadlineTimer ??= setTimeout(stopAtDeadline, deadline.remainingMs())
      const pushed = await Promise.race([
        (event.name === 'stdout' ? stdout : stderr).push(event.value),
        graceExpired,
        deadlinePassed,
      ])
      if (pushed === GRACE_EXPIRED || pushed === DEADLINE_PASSED) {
        if (pushed === DEADLINE_PASSED) void interrupt()
        detached = true
        void reader.cancel().catch(() => undefined)
        break
      }
    }
  } finally {
    clearTimeout(graceTimer)
    clearTimeout(deadlineTimer)
    reader.releaseLock()
    signal?.removeEventListener('abort', abort)
  }
  // A detached command's spills finish in the background: storage that
  // stalled the read loop must not hold the turn either. Otherwise the
  // spills are closed within what remains of the command's deadline (or a
  // cancellation grace), past which they too finish in the background; the
  // command itself has ended, so it is not reported detached.
  if (!detached) {
    await settledWithin(Promise.all([stdout.finish(), stderr.finish()]), deadline.remainingMs(), signal)
  }
  const out = await stdout.finish({ wait: false })
  const err = await stderr.finish({ wait: false })
  // Its end is no longer observable: the command's own timeout bounds it.
  if (detached) onDetached?.(deadline.expired())
  return {
    executionId: EdgeExecutionId(running.id),
    status: executionStatus(exitCode, interruptionRequested),
    timedOut: deadline.timedOut,
    timeoutMs: effectiveTimeoutMs,
    exitCode,
    stdout: out.text,
    stderr: err.text,
    outputTruncated: out.truncated || err.truncated || stoppedAtLightLimit,
    ...streamFacts('stdout', out),
    ...streamFacts('stderr', err),
    ...stoppedAtLightLimit ? { stoppedAtLightLimit: true } : {},
    ...detached ? { detached: true } : {},
  }
}

/** Where command output past the tail is saved, beside the other tool spills. */
const SHELL_SPILL_DIRECTORY = '/workspace/.spill'

function streamFacts(stream: ShellStream, captured: Awaited<ReturnType<StreamCapture['finish']>>): Partial<EdgeShellResult> {
  if (!captured.truncated) return {}
  return stream === 'stdout'
    ? { stdoutTruncated: true, ...captured.spillPath === undefined ? {} : { stdoutSpillPath: captured.spillPath }, ...captured.spillPartial === true ? { stdoutSpillPartial: true } : {}, ...captured.spillPending === true ? { stdoutSpillPending: true } : {} }
    : { stderrTruncated: true, ...captured.spillPath === undefined ? {} : { stderrSpillPath: captured.spillPath }, ...captured.spillPartial === true ? { stderrSpillPartial: true } : {}, ...captured.spillPending === true ? { stderrSpillPending: true } : {} }
}

/**
 * Whether `work` settles before `timeoutMs`, or before the cancellation grace
 * once `signal` aborts.
 */
async function settledWithin(work: Promise<unknown>, timeoutMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const bound = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    onAbort = () => { graceTimer ??= setTimeout(() => resolve(false), CANCELLED_COMMAND_GRACE_MS) }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work.then(() => true), bound])
  } finally {
    clearTimeout(timer)
    clearTimeout(graceTimer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

const GRACE_EXPIRED = Symbol('cancelled command grace expired')
const DEADLINE_PASSED = Symbol('command deadline passed while output waited for storage')

function commandDeadline(timeoutMs: number): { complete(): void; readonly timedOut: boolean; remainingMs(): number; expired(): Promise<void> } {
  const expiresAt = performance.now() + timeoutMs
  let completedAt: number | undefined
  return {
    complete() { completedAt ??= performance.now() },
    remainingMs: () => Math.max(0, expiresAt - performance.now()),
    get timedOut() { return (completedAt ?? performance.now()) >= expiresAt },
    expired: () => new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt - performance.now()))),
  }
}

function executionStatus(
  exitCode: number,
  interruptionRequested: boolean,
): EdgeShellResult['status'] {
  if (interruptionRequested) return 'cancelled'
  if (exitCode === 0) return 'completed'
  return 'failed'
}

function resolveDeploymentTimeout(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`dsh-edge: ${name} must be a positive integer`)
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-edge: ${name} must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}
