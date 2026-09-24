/**
 * Edge provider for the upstream `ctx.codeRuntime` seam, the executor behind
 * the `run_code` tool of `@deepseek-ai/dsh-tools` PTC mode. Offered only
 * where the Dynamic Worker runtime provider is available.
 *
 * The published worker-thread runtime compiles programs with
 * `new AsyncFunction`, strips types with `node:module`, and isolates them in a
 * Node Worker; workerd provides none of those. This runtime keeps its
 * contract (validated binding namespaces, typed binding rejections, a console
 * shim, the outer-output ledger, and the failure taxonomy) and runs each
 * program in its own Dynamic Worker:
 * - types are stripped on the host with sucrase, and the program is loaded as
 *   the body of a module function (a parse failure never loads an isolate);
 * - the isolate has no outbound network and a Worker Loader `cpuMs` limit
 *   (enforced by the Cloudflare runtime, not by local workerd);
 * - binding calls cross an RpcTarget bridge whose host side looks the member
 *   up as an own property, caps the call count (each call is a full nested tool
 *   dispatch with its own session events) and the argument and reply bytes,
 *   and snapshots every value as lossless JSON.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parse } from 'acorn'
import { RpcTarget } from 'cloudflare:workers'
import CodeRuntime, {
  DUNDER_MEMBER,
  PORTABLE_RESERVED_WORDS,
  RESERVED_BINDING_GLOBALS,
  RESERVED_ERROR_MEMBERS,
} from '@deepseek-ai/dsh-code-runtime'
import type {
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
} from '@deepseek-ai/dsh-code-runtime'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { transform } from 'sucrase'
import {
  CODE_ENTRY_MODULE,
  CODE_ENTRY_SOURCE,
  CODE_PROGRAM_MODULE,
  CODE_RUNTIME_MODULE,
  CODE_RUNTIME_SOURCE,
  codeProgramSource,
} from './edge-code-runtime-isolate.ts'
import { WORKFLOW_COMPATIBILITY_DATE } from './edge-workflow-engine.ts'
import type { WorkflowLoader } from './edge-workflow-engine.ts'

export interface EdgeCodeRuntimeConfig {
  /** Worker Loader that creates one isolate per run. */
  loader: WorkflowLoader
  /** CPU budget of one run's isolate; bounds every synchronous computation in the program. */
  cpuMs: number
  /** Wall-clock ceiling of one run, including time spent in binding calls and approvals. */
  maxWallMs: number
  /** Bytes of the JSON-encoded outer output: logs plus the completion value or failure message. */
  maxOutputBytes: number
  /** Characters of program source accepted before type stripping. */
  maxSourceChars: number
  /** Binding calls one run may make (each is a nested tool dispatch that writes session events). */
  maxBindingCalls: number
  /** Bytes of one call's JSON-encoded arguments. */
  maxBindingArgBytes: number
  /** Bytes of one call's JSON-encoded resolution sent back to the isolate. */
  maxBindingReplyBytes: number
  /** How long disposal waits for a run's isolate to settle. */
  disposeGraceMs: number
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u

type BridgeReply = { ok: true, value: CodeJsonValue } | { ok: false, message: string }

interface IsolateOutcome {
  value?: unknown
  error?: { kind?: unknown, message?: unknown }
}

export default class EdgeCodeRuntime extends CodeRuntime {
  static Config: z<EdgeCodeRuntimeConfig> = z.object({
    loader: z.any().required() as z<WorkflowLoader>,
    cpuMs: z.natural().min(1).default(30_000),
    maxWallMs: z.natural().min(1).default(300_000),
    maxOutputBytes: z.natural().min(64).default(1024 * 1024),
    maxSourceChars: z.natural().min(1).default(256 * 1024),
    maxBindingCalls: z.natural().min(1).default(200),
    maxBindingArgBytes: z.natural().min(1).default(256 * 1024),
    maxBindingReplyBytes: z.natural().min(1).default(2 * 1024 * 1024),
    disposeGraceMs: z.natural().default(5_000),
  })

  readonly language = 'typescript'
  readonly isolation = 'dynamic-worker'
  private readonly live = new Set<CodeRun>()
  private disposed = false

  constructor(ctx: Context, private readonly config: EdgeCodeRuntimeConfig) {
    super(ctx)
    ctx.effect(() => () => this.teardown(), 'edge code-runtime teardown')
  }

  /**
   * Run one program in a fresh isolate. Program outcomes, including a
   * type-strip or parse failure, resolve with `result.error`; only seam
   * misuse (a disposed runtime, an invalid binding namespace) rejects.
   */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('edge code-runtime: run() after disposal')
    const bindings = validateBindings(request.bindings)
    const ledger = new OutputLedger(this.config.maxOutputBytes)
    if (request.signal?.aborted === true) {
      return ledger.failure([], { kind: 'abort', message: String(request.signal.reason) })
    }
    let source: string
    try {
      source = buildProgramModule(request.program, bindings, this.config.maxSourceChars)
    } catch (error) {
      return ledger.failure([], { kind: 'exception', message: messageOf(error) })
    }
    const run = new CodeRun(this.ctx, this.config, bindings, source, request.signal, ledger)
    this.live.add(run)
    try {
      return await run.result
    } finally {
      this.live.delete(run)
    }
  }

  private async teardown(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const run of runs) run.settle({ kind: 'abort', message: 'runtime disposed' })
    await Promise.all(runs.map(run => run.result))
  }
}

/** Reject malformed binding globals or error classes as seam misuse, mirroring the worker-thread runtime. */
function validateBindings(namespaces: readonly CodeBindingNamespace[]): Map<string, CodeBindingNamespace> {
  const bindings = new Map<string, CodeBindingNamespace>()
  for (const namespace of namespaces) {
    const global = namespace.global
    if (!IDENTIFIER.test(global) || PORTABLE_RESERVED_WORDS.has(global)) {
      throw new Error(`edge code-runtime: binding global ${JSON.stringify(global)} is not a usable identifier`)
    }
    if (RESERVED_BINDING_GLOBALS.has(global)) throw new Error(`edge code-runtime: reserved binding global ${JSON.stringify(global)}`)
    if (bindings.has(global)) throw new Error(`edge code-runtime: duplicate binding global ${JSON.stringify(global)}`)
    bindings.set(global, namespace)
  }
  const errorClassNames = new Set<string>()
  for (const namespace of namespaces) {
    const descriptor = namespace.errorClass
    if (descriptor === undefined) continue
    if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
      throw new Error(`edge code-runtime: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
    }
    if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) {
      throw new Error(`edge code-runtime: reserved binding global ${JSON.stringify(descriptor.name)}`)
    }
    if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
      throw new Error(`edge code-runtime: duplicate injected global ${JSON.stringify(descriptor.name)}`)
    }
    const member = descriptor.memberNameProperty
    if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
      throw new Error(`edge code-runtime: binding error member property ${JSON.stringify(member)} is not usable`)
    }
    errorClassNames.add(descriptor.name)
  }
  return bindings
}

/**
 * Strip types and wrap the program exactly as the isolate will load it.
 * Sucrase keeps line numbers and turns non-erasable syntax such as `enum`
 * into JavaScript (the worker-thread runtime rejects it instead).
 */
export function buildProgramModule(program: string, bindings: Map<string, CodeBindingNamespace>, maxSourceChars: number): string {
  if (program.length > maxSourceChars) {
    throw new Error(`program is ${program.length} characters, over the ${maxSourceChars}-character limit`)
  }
  const parameters = [
    ...bindings.keys(),
    ...[...bindings.values()].flatMap(namespace => namespace.errorClass === undefined ? [] : [namespace.errorClass.name]),
    'console',
  ]
  const typed = codeProgramSource(program, parameters)
  const stripped = transform(typed, { transforms: ['typescript'], disableESTransforms: true }).code
  const module = parse(stripped, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as { body: { type: string }[] }
  if (module.body.length !== 1 || module.body[0]?.type !== 'ExportDefaultDeclaration') {
    throw new Error('the program must not close its wrapper function')
  }
  return stripped
}

/**
 * The only host object the isolate reaches. RPC exposes its prototype
 * methods; the run stays in a private field.
 */
class CodeRunBridge extends RpcTarget {
  readonly #run: CodeRun

  constructor(run: CodeRun) {
    super()
    this.#run = run
  }

  call(global: unknown, name: unknown, args: unknown): Promise<BridgeReply> {
    return this.#run.bridgeCall(global, name, args)
  }

  log(text: unknown): void {
    this.#run.bridgeLog(text)
  }
}

/** One run: owns its isolate, logs, ledger, and settlement. `result` never rejects. */
class CodeRun {
  readonly result: Promise<CodeRunResult>
  private resolveResult!: (result: CodeRunResult) => void
  private settled = false
  private calls = 0
  private readonly logs: string[] = []
  private isolate: { worker: unknown, entrypoint: unknown } | undefined
  private wallTimer: ReturnType<typeof setTimeout> | undefined
  private readonly onAbort = () => { this.settle({ kind: 'abort', message: String(this.signal?.reason) }) }
  /**
   * The async context of the `run_code` call that started this run. Bridge
   * calls arrive from the isolate as fresh RPC invocations, outside it, so
   * nested tool dispatches re-enter it (the turn's filesystem binding and
   * every other AsyncLocalStorage store live there).
   */
  private readonly turnContext = AsyncLocalStorage.snapshot()

  constructor(
    private readonly ctx: Context,
    private readonly config: EdgeCodeRuntimeConfig,
    private readonly bindings: Map<string, CodeBindingNamespace>,
    source: string,
    private readonly signal: AbortSignal | undefined,
    private readonly ledger: OutputLedger,
  ) {
    this.result = new Promise(resolve => { this.resolveResult = resolve })
    signal?.addEventListener('abort', this.onAbort, { once: true })
    this.wallTimer = setTimeout(() => {
      this.settle({ kind: 'timeout', message: `wall-clock ceiling reached (${config.maxWallMs}ms)` })
    }, config.maxWallMs)
    let evaluation: Promise<unknown>
    try {
      const limits = { cpuMs: config.cpuMs }
      const worker = config.loader.load({
        compatibilityDate: WORKFLOW_COMPATIBILITY_DATE,
        mainModule: CODE_ENTRY_MODULE,
        modules: {
          [CODE_ENTRY_MODULE]: CODE_ENTRY_SOURCE,
          [CODE_RUNTIME_MODULE]: CODE_RUNTIME_SOURCE,
          [CODE_PROGRAM_MODULE]: source,
        },
        limits,
        globalOutbound: null,
      })
      // Held before getEntrypoint() so a failure there still disposes the worker.
      this.isolate = { worker, entrypoint: undefined }
      const entrypoint = worker.getEntrypoint(undefined, { limits }) as {
        evaluate(host: CodeRunBridge, input: unknown): Promise<unknown>
      }
      this.isolate.entrypoint = entrypoint
      evaluation = Promise.resolve(entrypoint.evaluate(new CodeRunBridge(this), {
        namespaces: [...bindings.values()].map(namespace => ({
          global: namespace.global,
          names: Object.keys(namespace.functions),
          ...namespace.errorClass !== undefined ? { errorClass: { ...namespace.errorClass } } : {},
        })),
        maxBindingCalls: config.maxBindingCalls,
        maxBindingArgBytes: config.maxBindingArgBytes,
        maxCompletionBytes: config.maxOutputBytes,
      }))
    } catch (error) {
      evaluation = Promise.reject(error)
    }
    evaluation.then(
      envelope => { this.complete((envelope as { outcome?: IsolateOutcome } | null | undefined)?.outcome) },
      (error: unknown) => {
        const message = messageOf(error)
        // Exceeding the Worker Loader cpuMs limit rejects the evaluation; the exact text is platform-owned.
        this.settle(/cpu/iu.test(message)
          ? { kind: 'timeout', message: `compute budget exhausted: ${message}` }
          : { kind: 'worker-exit', message: `isolate failed: ${message}` })
      },
    )
  }

  /** Bridge entry for one binding call, run inside the starting call's async context. */
  bridgeCall(global: unknown, name: unknown, args: unknown): Promise<BridgeReply> {
    return this.turnContext(() => this.dispatchCall(global, name, args))
  }

  private async dispatchCall(global: unknown, name: unknown, args: unknown): Promise<BridgeReply> {
    if (this.settled) return { ok: false, message: 'the run has finished' }
    if (typeof global !== 'string' || typeof name !== 'string') return { ok: false, message: 'malformed binding call' }
    if (this.calls >= this.config.maxBindingCalls) {
      return { ok: false, message: `this run reached its binding call cap (${this.config.maxBindingCalls})` }
    }
    const argBytes = jsonBytes(args)
    if (argBytes > this.config.maxBindingArgBytes) {
      return { ok: false, message: `binding arguments are ${argBytes} bytes, over the ${this.config.maxBindingArgBytes}-byte limit` }
    }
    const functions = this.bindings.get(global)?.functions
    const fn = functions !== undefined && Object.hasOwn(functions, name) ? functions[name] : undefined
    if (typeof fn !== 'function') return { ok: false, message: `unknown binding ${JSON.stringify(`${global}.${name}`)}` }
    let detached: unknown
    try {
      detached = snapshotJsonValue(args)
    } catch {
      detached = undefined
    }
    if (detached === undefined) return { ok: false, message: 'binding arguments must be lossless JSON' }
    this.calls += 1
    let resolved: unknown
    try {
      resolved = await fn(detached)
    } catch (error) {
      return { ok: false, message: clip(messageOf(error), 16 * 1024) }
    }
    let value: CodeJsonValue | undefined
    try {
      value = snapshotJsonValue(resolved) as CodeJsonValue | undefined
    } catch {
      value = undefined
    }
    if (value === undefined) return { ok: false, message: 'binding resolution must be lossless JSON' }
    const replyBytes = jsonBytes(value)
    if (replyBytes > this.config.maxBindingReplyBytes) {
      return { ok: false, message: `binding result is ${replyBytes} bytes, over the ${this.config.maxBindingReplyBytes}-byte limit` }
    }
    return { ok: true, value }
  }

  /** Bridge entry for console output; the ledger decides what is kept. */
  bridgeLog(text: unknown): void {
    if (this.settled || typeof text !== 'string') return
    if (!this.ledger.admit(text, this.logs)) this.finish(this.ledger.limit([...this.logs, text]))
  }

  /** Settle as a failure (abort, timeout, disposal, isolate death). */
  settle(failure: CodeRunFailure): void {
    this.finish(this.ledger.failure(this.logs, failure))
  }

  private complete(outcome: IsolateOutcome | undefined): void {
    if (this.settled) return
    if (outcome === undefined || typeof outcome !== 'object') {
      this.settle({ kind: 'worker-exit', message: 'isolate returned no outcome' })
      return
    }
    const error = outcome.error
    if (error !== undefined) {
      const kind = error.kind === 'invalid-output' || error.kind === 'output-limit' ? error.kind : 'exception'
      this.settle({ kind, message: typeof error.message === 'string' ? error.message : 'program failed' })
      return
    }
    if (!('value' in outcome)) {
      this.finish(this.ledger.success(this.logs))
      return
    }
    const value = snapshotJsonValue(outcome.value) as CodeJsonValue | undefined
    if (value === undefined) {
      this.settle({ kind: 'invalid-output', message: 'program completion must be lossless JSON' })
      return
    }
    this.finish(this.ledger.success(this.logs, value))
  }

  private finish(result: CodeRunResult): void {
    if (this.settled) return
    this.settled = true
    clearTimeout(this.wallTimer)
    this.signal?.removeEventListener('abort', this.onAbort)
    this.terminateIsolate()
    this.resolveResult(result)
  }

  private terminateIsolate(): void {
    const isolate = this.isolate
    this.isolate = undefined
    if (isolate === undefined) return
    for (const handle of [isolate.entrypoint, isolate.worker]) {
      if (handle === undefined) continue
      try {
        (handle as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
      } catch (error) {
        this.ctx.logger.warn(`edge code-runtime: isolate dispose failed: ${messageOf(error)}`)
      }
    }
  }
}

/**
 * The run's outer-output budget over the JSON encoding of its logs plus the
 * completion value or failure message. Binding values never enter it.
 */
export class OutputLedger {
  private bytes = 2

  constructor(private readonly maxBytes: number) {}

  /** Admit one log entry, or report that it would cross the cap. */
  admit(text: string, sink: string[]): boolean {
    const size = jsonBytes(text) + (sink.length > 0 ? 1 : 0)
    if (this.bytes + size > this.maxBytes) return false
    this.bytes += size
    sink.push(text)
    return true
  }

  success(logs: string[], value?: CodeJsonValue): CodeRunResult {
    if (value !== undefined && this.bytes + jsonBytes(value) > this.maxBytes) return this.limit(logs)
    return { logs: [...logs], ...value !== undefined ? { value } : {} }
  }

  failure(logs: string[], error: CodeRunFailure): CodeRunResult {
    if (this.bytes + jsonBytes(error.message) > this.maxBytes) return this.limit(logs)
    return { logs: [...logs], error }
  }

  /** The explicit output-limit failure, keeping the logs that fit beside its message. */
  limit(logs: string[]): CodeRunResult {
    const message = `outer output exceeded ${this.maxBytes} bytes`
    const budget = this.maxBytes - jsonBytes(message)
    const kept: string[] = []
    let used = 2
    for (const text of logs) {
      const size = jsonBytes(text) + (kept.length > 0 ? 1 : 0)
      if (used + size > budget) break
      kept.push(text)
      used += size
    }
    return { logs: kept, error: { kind: 'output-limit', message } }
  }
}

function jsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 0 : new TextEncoder().encode(text).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}
