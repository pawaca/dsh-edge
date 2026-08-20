/** In-process just-bash backend for the Cloudflare Computer workspace runtime. */

import type { BackendHandle, WorkspaceBackend } from '@cloudflare/computer'
import {
  WorkspaceFsAdapter,
  defineArtifactsCommand,
  defineAssetsCommand,
  defineGitCommand,
  type WorkspaceFs,
} from '@cloudflare/computer/backends/worker-shell'
import {
  Bash,
  type BashExecResult,
  type IFileSystem,
} from 'just-bash/browser'
import {
  DIRECT_SHELL_OUTPUT_TRUNCATED,
  EDGE_SHELL_OUTPUT_LIMIT_BYTES,
} from './direct-shell-protocol.ts'

const DEFAULT_BACKEND_ID = 'worker-shell'
const DEFAULT_CWD = '/workspace'
type DirectBackendHost = Parameters<WorkspaceBackend['connect']>[0]
type WorkspaceSyncRpc = BackendHandle['rpc']['sync']
type ShellExec = BackendHandle['rpc']['shell']['exec']
type ShellExecInput = Parameters<ShellExec>[0]
type ShellExecEnvelope = Awaited<ReturnType<ShellExec>>
type ShellExecEvent = ShellExecEnvelope['events'] extends ReadableStream<infer Event>
  ? Event
  : never

interface DirectBashExecOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  stdinKind?: 'bytes'
  signal?: AbortSignal
}

interface DirectExecution {
  controller: AbortController
  done: Promise<void>
}

interface DirectBashOutcome {
  result: BashExecResult
  terminalResult?: typeof DIRECT_SHELL_OUTPUT_TRUNCATED
}

/** Options for the free in-process shell backend. */
export interface DirectShellBackendOptions {
  id?: string
}

/** Run just-bash in the owning Durable Object against Computer's local VFS. */
export class DirectShellBackend implements WorkspaceBackend {
  readonly type = 'direct-shell'
  readonly id: string

  constructor(options: DirectShellBackendOptions = {}) {
    this.id = options.id ?? DEFAULT_BACKEND_ID
  }

  /** Connect one workspace-local shell runtime. */
  connect(host: DirectBackendHost): Promise<BackendHandle> {
    const runtime = new DirectShellRuntime(host)
    return Promise.resolve({
      rpc: {
        sync: disabledSyncRpc(),
        shell: {
          exec: input => runtime.exec(input),
          getExec: input => runtime.getExec(input.id),
          killExec: input => runtime.killExec(input.id, input.signal),
          disposeExec: input => runtime.disposeExec(input.id),
        },
      },
      sync: 'none',
      close: () => runtime.close(),
    })
  }
}

class DirectShellRuntime {
  private readonly fs: WorkspaceFsAdapter
  private readonly executions = new Map<string, DirectExecution>()
  private closed = false

  constructor(private readonly host: DirectBackendHost) {
    this.fs = new WorkspaceFsAdapter(workspaceFs(host))
  }

  exec(input: ShellExecInput): Promise<ShellExecEnvelope> {
    if (this.closed) throw directShellError('ECLOSED', 'direct shell backend is closed')
    const id = input.id ?? crypto.randomUUID()
    if (this.executions.has(id)) {
      throw directShellError('EEXEC_BUSY', `execution ${id} is running`)
    }

    const controller = new AbortController()
    const result = Promise.resolve().then(() => this.run(input, controller.signal))
    const done = result.then(() => undefined, () => undefined)
    this.executions.set(id, { controller, done })
    return Promise.resolve({
      id,
      events: executionEvents(
        id,
        result,
        () => { this.deleteExecution(id, controller) },
        () => this.disposeExec(id),
      ),
    })
  }

  getExec(id: string): Promise<ShellExecEnvelope> {
    throw directShellError('ENOENT', `no such exec: ${id}`)
  }

  killExec(id: string, signal = 'SIGTERM'): Promise<void> {
    this.executions.get(id)?.controller.abort(
      directShellError('EEXEC_CANCELLED', `execution cancelled with ${signal}`),
    )
    return Promise.resolve()
  }

  async disposeExec(id: string): Promise<void> {
    const execution = this.executions.get(id)
    if (execution === undefined) return
    execution.controller.abort(
      directShellError('EEXEC_DISPOSED', `execution disposed: ${id}`),
    )
    await execution.done
    this.deleteExecution(id, execution.controller)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const active = [...this.executions.values()]
    for (const execution of active) {
      execution.controller.abort(directShellError('ECLOSED', 'direct shell backend is closing'))
    }
    await Promise.allSettled(active.map(execution => execution.done))
    this.executions.clear()
  }

  private async run(input: ShellExecInput, signal: AbortSignal): Promise<DirectBashOutcome> {
    const timeoutLimit = input.timeoutMs !== undefined && input.timeoutMs > 0
      ? { maxExecutionTimeMs: input.timeoutMs }
      : {}
    const bash = new Bash({
      // Computer and just-bash accept the same runtime encodings, but their
      // interfaces spell the optional UTF-8 alias set differently.
      fs: this.fs as unknown as IFileSystem,
      cwd: input.cwd ?? DEFAULT_CWD,
      ...(input.env === undefined ? {} : { env: input.env }),
      customCommands: [
        defineGitCommand(this.host),
        defineAssetsCommand({}),
        defineArtifactsCommand(this.host),
      ],
      defenseInDepth: { enabled: 'auto' },
      executionLimitProfile: 'hardened',
      executionLimits: {
        maxOutputSize: EDGE_SHELL_OUTPUT_LIMIT_BYTES,
        ...timeoutLimit,
      },
    })
    const directBash = bash as unknown as {
      exec(command: string, options: DirectBashExecOptions): Promise<BashExecResult>
    }
    try {
      const result = await directBash.exec(input.source, {
        cwd: input.cwd ?? DEFAULT_CWD,
        ...(input.env === undefined ? {} : { env: input.env }),
        ...(input.stdin === undefined
          ? {}
          : { stdin: latin1FromBytes(input.stdin), stdinKind: 'bytes' as const }),
        signal,
      })
      return {
        result,
        ...(hitDirectOutputLimit(result)
          ? { terminalResult: DIRECT_SHELL_OUTPUT_TRUNCATED }
          : {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        result: {
          stdout: '',
          stderr: `${message}\n`,
          exitCode: signal.aborted ? 130 : 1,
          env: input.env ?? {},
        },
      }
    }
  }

  private deleteExecution(id: string, controller: AbortController): void {
    if (this.executions.get(id)?.controller === controller) this.executions.delete(id)
  }
}

function workspaceFs(host: DirectBackendHost): WorkspaceFs {
  const fs = host.fs
  return {
    readFile: fs.readFile.bind(fs),
    exists: async path => await statOrNull(() => fs.stat(path)) !== null,
    stat: path => fs.stat(path),
    statOrNull: path => statOrNull(() => fs.stat(path)),
    lstat: path => fs.lstat(path),
    lstatOrNull: path => statOrNull(() => fs.lstat(path)),
    readdir: path => fs.readdir(path),
    find: (directory, pattern) => fs.find(directory, pattern),
    ls: prefix => fs.ls(prefix),
    grep: (pattern, path, options) => fs.grep(pattern, path, options),
    readlink: path => fs.readlink(path),
    writeFile: (path, content, options) => fs.writeFile(path, content, options),
    mkdir: (path, options) => fs.mkdir(path, options),
    rm: (path, options) => fs.rm(path, options),
    chmod: (path, mode) => fs.chmod(path, mode),
    symlink: (target, path) => fs.symlink(target, path),
  }
}

async function statOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code
}

function executionEvents(
  id: string,
  result: Promise<DirectBashOutcome>,
  onTerminal: () => void,
  onCancel: () => Promise<void>,
): ReadableStream<ShellExecEvent> {
  const encoder = new TextEncoder()
  let events: ShellExecEvent[] | undefined
  return new ReadableStream({
    async pull(controller) {
      try {
        events ??= shellExecEvents(id, encoder, await result)
        const event = events.shift()
        if (event === undefined) return
        controller.enqueue(event)
        if (event.name === 'exit') {
          controller.close()
          onTerminal()
        }
      } catch (error) {
        controller.error(error)
        onTerminal()
      }
    },
    cancel: onCancel,
  }, { highWaterMark: 0 })
}

function shellExecEvents(
  id: string,
  encoder: TextEncoder,
  outcome: DirectBashOutcome,
): ShellExecEvent[] {
  const { result } = outcome
  const events: ShellExecEvent[] = []
  let seq = 0
  if (result.stdout.length > 0) {
    events.push({ id, seq: ++seq, name: 'stdout', value: encoder.encode(result.stdout) })
  }
  if (result.stderr.length > 0) {
    events.push({ id, seq: ++seq, name: 'stderr', value: encoder.encode(result.stderr) })
  }
  events.push({
    id,
    seq: ++seq,
    name: 'exit',
    code: result.exitCode,
    ...(outcome.terminalResult === undefined ? {} : { result: outcome.terminalResult }),
  })
  return events
}

function hitDirectOutputLimit(result: BashExecResult): boolean {
  if (result.exitCode !== 126) return false
  const accountedBytes = result.internalOutputAccounting?.stderr
  if (accountedBytes === undefined) return false
  const stderr = new TextEncoder().encode(result.stderr)
  if (accountedBytes < 0 || accountedBytes > stderr.byteLength) return false
  const interpreterDiagnostic = new TextDecoder().decode(stderr.subarray(accountedBytes))
  return [
    `limit exceeded (${EDGE_SHELL_OUTPUT_LIMIT_BYTES} bytes)`,
    `total output size exceeded (>${EDGE_SHELL_OUTPUT_LIMIT_BYTES} bytes), `
      + 'increase executionLimits.maxOutputSize',
  ].some(diagnostic => interpreterDiagnostic.includes(diagnostic))
}

function latin1FromBytes(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) result += String.fromCharCode(byte)
  return result
}

function directShellError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.name = 'DirectShellError'
  error.code = code
  return error
}

function disabledSyncRpc(): WorkspaceSyncRpc {
  const refuse = (name: string): never => {
    throw directShellError(
      'ENOSYS',
      `DirectShellBackend: sync.${name} must not be called because sync is disabled`,
    )
  }
  return {
    push: () => refuse('push'),
    fetchChanges: () => refuse('fetchChanges'),
    watermarks: () => refuse('watermarks'),
    readEntry: () => refuse('readEntry'),
    hasObjects: () => refuse('hasObjects'),
    fetchObjects: () => new ReadableStream({
      start(controller) {
        controller.error(directShellError('ENOSYS', 'DirectShellBackend: sync is disabled'))
      },
    }),
    pushObjects: () => refuse('pushObjects'),
  }
}
