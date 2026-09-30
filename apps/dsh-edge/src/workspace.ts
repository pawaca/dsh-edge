/** Validation and execution helpers for the Cloudflare Computer workspace. */

import { getWorkspace } from '@cloudflare/computer'
import type { EdgeShellResult } from './agent.ts'
import {
  DIRECT_SHELL_OUTPUT_TRUNCATED,
  EDGE_SHELL_OUTPUT_LIMIT_BYTES,
} from './direct-shell-protocol.ts'
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
    // Still running after its interrupt: stop waiting, release it once it answers.
    signal?.removeEventListener('abort', abort)
    void starting.then(late => late[Symbol.dispose]?.(), () => undefined)
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
  const stdout: Uint8Array[] = []
  const stderr: Uint8Array[] = []
  let retainedBytes = 0
  let outputTruncated = false
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
        if (event.result === DIRECT_SHELL_OUTPUT_TRUNCATED) {
          outputTruncated = true
          interruptionRequested = true
        }
        continue
      }

      const remaining = EDGE_SHELL_OUTPUT_LIMIT_BYTES - retainedBytes
      if (remaining > 0) {
        // Copy rather than retain a subarray view: an oversized event may use
        // a much larger backing buffer that must become collectible here.
        const retained = event.value.slice(0, remaining)
        if (event.name === 'stdout') stdout.push(retained)
        else stderr.push(retained)
        retainedBytes += retained.byteLength
      }
      if (event.value.byteLength > remaining && !outputTruncated) {
        outputTruncated = true
        await interrupt()
      }
    }
  } finally {
    clearTimeout(graceTimer)
    reader.releaseLock()
    signal?.removeEventListener('abort', abort)
  }
  return {
    executionId: EdgeExecutionId(running.id),
    status: executionStatus(exitCode, interruptionRequested),
    timedOut: deadline.timedOut,
    exitCode,
    stdout: decodeChunks(stdout),
    stderr: decodeChunks(stderr),
    outputTruncated,
    ...detached ? { detached: true } : {},
  }
}

const GRACE_EXPIRED = Symbol('cancelled command grace expired')

function commandDeadline(timeoutMs: number): { complete(): void; readonly timedOut: boolean } {
  const expiresAt = performance.now() + timeoutMs
  let completedAt: number | undefined
  return {
    complete() { completedAt ??= performance.now() },
    get timedOut() { return (completedAt ?? performance.now()) >= expiresAt },
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

function decodeChunks(chunks: Uint8Array[]): string {
  // Decode like a terminal: bytes that are not UTF-8 (a GBK page, a binary
  // file, or `head -c` cutting a character mid-output) become U+FFFD instead
  // of failing the command. Streaming mode holds back an incomplete sequence
  // at the very end, which is where the output limit cuts; it is dropped
  // rather than shown as a replacement character.
  const decoder = new TextDecoder('utf-8')
  let text = ''
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
  return text
}
