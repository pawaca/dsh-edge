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
export async function executeWorkspaceCommand(
  workspace: EdgeWorkspace,
  command: string,
  cwd: string,
  timeoutPolicy: EdgeCommandTimeoutPolicy,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<EdgeShellResult> {
  const effectiveTimeoutMs = timeoutMs ?? timeoutPolicy.defaultTimeoutMs
  if (!Number.isInteger(effectiveTimeoutMs)
    || effectiveTimeoutMs <= 0
    || effectiveTimeoutMs > timeoutPolicy.maxTimeoutMs) {
    throw new EdgeWorkspaceRequestError(
      400,
      `timeoutMs must be a positive integer no greater than ${timeoutPolicy.maxTimeoutMs}.`,
    )
  }
  signal?.throwIfAborted()
  await workspace.fs.mkdir('/workspace', { recursive: true })
  signal?.throwIfAborted()
  const deadline = commandDeadline(effectiveTimeoutMs)
  using execution = await workspace.runtime.exec(command, {
    cwd,
    timeoutMs: effectiveTimeoutMs,
  })
  let interruptionRequested = false
  const interrupt = (): Promise<void> => {
    interruptionRequested = true
    return execution.kill('SIGINT').catch(() => undefined)
  }
  const abort = (): void => {
    void interrupt()
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted === true) abort()
  const stdout: Uint8Array[] = []
  const stderr: Uint8Array[] = []
  let retainedBytes = 0
  let outputTruncated = false
  let exitCode = -1
  const reader = execution.getReader()
  try {
    while (true) {
      const next = await reader.read()
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
    reader.releaseLock()
    signal?.removeEventListener('abort', abort)
  }
  return {
    executionId: EdgeExecutionId(execution.id),
    status: executionStatus(exitCode, interruptionRequested),
    timedOut: deadline.timedOut,
    exitCode,
    stdout: decodeChunks(stdout),
    stderr: decodeChunks(stderr),
    outputTruncated,
  }
}

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
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const output = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  // A byte-exact cut can land inside one UTF-8 code point. The shell backend
  // encoded these bytes from strings, so at most the final three bytes need
  // dropping to retain a valid prefix without introducing U+FFFD expansion.
  for (let dropped = 0; dropped <= 3 && dropped <= output.byteLength; dropped += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        output.subarray(0, output.byteLength - dropped),
      )
    } catch {
      // Try the preceding UTF-8 boundary.
    }
  }
  throw new Error('dsh-edge: shell output was not valid UTF-8')
}
