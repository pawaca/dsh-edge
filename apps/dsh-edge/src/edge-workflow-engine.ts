/**
 * Edge provider for the upstream `ctx.workflowEngine` seam, offered only where
 * the Dynamic Worker runtime provider is available (the Worker Loader binding).
 *
 * The published `@deepseek-ai/dsh-workflow-worker-thread` engine needs
 * `node:vm` and `node:worker_threads`, which workerd does not provide. This
 * engine keeps that engine's script contract (hooks, caps, fatal-error
 * discipline, event pairing, never-rejecting result) and replaces the worker
 * thread with a Dynamic Worker per run:
 * - the script runs in its own isolate with no outbound network, so it can
 *   neither reach nor corrupt the Durable Object's realm;
 * - the Worker Loader `cpuMs` custom limit makes the isolate throw once its
 *   synchronous work (native builtins included) exceeds the budget; the
 *   Cloudflare runtime enforces it, local workerd does not. Disposing the
 *   isolate ends it on cancellation, and a grace timer settles the run if the
 *   pending evaluation never observes that;
 * - `agent()`, `phase()`, and `log()` cross an RPC bridge, and every check that
 *   protects the Durable Object (arguments, caps, concurrency, child
 *   lifecycle, events) runs on the host side of that bridge.
 * Default caps are sized for Durable Object limits: at most six concurrent
 * outbound connections per invocation, and SQLite row writes for each child
 * session.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parse } from 'acorn'
import { RpcTarget } from 'cloudflare:workers'
import WorkflowEngine, { WorkflowError, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowMeta,
  WorkflowPhase,
  WorkflowResult,
  WorkflowRun,
  WorkflowRunInfo,
  WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { JsonSchemaError, assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  MAX_AGENT_REQUEST_BYTES,
  MAX_PROGRESS_CHARS,
  MAX_RESULT_BYTES,
  WORKFLOW_BODY_MODULE,
  WORKFLOW_ENTRY_MODULE,
  WORKFLOW_ENTRY_SOURCE,
  WORKFLOW_RUNTIME_MODULE,
  WORKFLOW_RUNTIME_SOURCE,
  workflowBodySource,
} from './edge-workflow-runtime.ts'

/** The Worker Loader surface a run needs (the `worker_loaders` binding). */
export interface WorkflowLoader {
  load(code: {
    compatibilityDate: string
    mainModule: string
    modules: Record<string, string>
    limits?: { cpuMs?: number }
    globalOutbound?: null
  }): { getEntrypoint(name?: string, options?: { limits?: { cpuMs?: number } }): unknown }
}

/** Compatibility date the workflow isolate runs with; a test keeps it equal to `wrangler.jsonc`. */
export const WORKFLOW_COMPATIBILITY_DATE = '2026-08-14'

export interface EdgeWorkflowEngineConfig {
  /** Worker Loader that creates one isolate per run. */
  loader: WorkflowLoader
  /** CPU budget of one run's isolate; bounds every synchronous computation in the script. */
  cpuMs: number
  /** Subagent provider every `agent()` call starts its child on. */
  provider: string
  /** Children allowed to run at once; keep below the Workers six-connection limit. */
  maxConcurrentAgents: number
  /** Children one run may start over its lifetime (bounds child-session row writes). */
  maxTotalAgents: number
  /** `phase()`/`log()` events one run may emit; later ones are ignored. */
  maxProgressEvents: number
  /** Items one `parallel()`/`pipeline()` call may receive. */
  maxItemsPerCall: number
  /** How long cancellation and disposal wait for the script and children to settle. */
  disposeGraceMs: number
}

const SUPPORTED_AGENT_OPTIONS = new Set(['label', 'phase', 'schema', 'provider', 'model'])
const DEFERRED_AGENT_OPTIONS = new Set(['effort', 'isolation', 'agentType'])
const SUPPORTED_OPTIONS_TEXT = 'supported: label, phase, schema, provider, model'

export default class EdgeWorkflowEngine extends WorkflowEngine {
  static inject = ['subagents']

  static Config: z<EdgeWorkflowEngineConfig> = z.object({
    loader: z.any().required() as z<WorkflowLoader>,
    cpuMs: z.natural().min(1).default(30_000),
    provider: z.string().default('spawn'),
    maxConcurrentAgents: z.natural().min(1).default(4),
    maxTotalAgents: z.natural().min(1).default(100),
    maxItemsPerCall: z.natural().min(1).default(1024),
    maxProgressEvents: z.natural().default(1_000),
    disposeGraceMs: z.natural().default(5_000),
  })

  constructor(ctx: Context, private readonly config: EdgeWorkflowEngineConfig) {
    super(ctx)
  }

  /**
   * Validate and start a workflow run. Throws {@link WorkflowError}
   * synchronously for a request that cannot begin; afterwards every failure
   * resolves through `result.stopReason`.
   */
  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta)
    assertBodyParses(request.script, meta.name)
    const provider = this.resolveProvider(request.subagentProvider)
    const maxTotalAgents = resolveMaxTotalAgents(request.maxTotalAgents, this.config.maxTotalAgents)
    const info: WorkflowRunInfo = { id: WorkflowRunId(crypto.randomUUID()), meta }
    const run = new EdgeWorkflowRun(this.ctx, info, request, provider, {
      ...this.config,
      maxTotalAgents,
    }, {
      phase: title => { this.emitWorkflowEvent('workflow/phase', info, title) },
      log: message => { this.emitWorkflowEvent('workflow/log', info, message) },
      agentStart: agent => { this.emitWorkflowEvent('workflow/agent-start', info, agent) },
      agentEnd: agent => { this.emitWorkflowEvent('workflow/agent-end', info, agent) },
    })
    this.emitWorkflowEvent('workflow/start', info)
    void run.result.then(settled => {
      this.emitWorkflowEvent('workflow/end', info, {
        stopReason: settled.stopReason,
        ...settled.error !== undefined ? { error: settled.error } : {},
        agentsStarted: settled.agentsStarted,
      })
    })
    // The isolate starts after start() returns, as with the worker-thread engine,
    // so the caller can attach its recorder before any hook fires.
    queueMicrotask(() => { run.begin() })
    return run
  }

  private resolveProvider(override: string | undefined): string {
    const provider = override ?? this.config.provider
    if (provider.length === 0 || provider !== provider.trim()) {
      throw new WorkflowError('workflow subagentProvider must be a non-empty normalized string', 'INVALID_ARGUMENT')
    }
    if (this.ctx.subagents.getProvider(provider) === undefined) {
      throw new WorkflowError(`no subagent provider registered for "${provider}"`, 'AGENT_START')
    }
    return provider
  }
}

type BridgeReply = { ok: true, value: unknown } | { ok: false, code: string, message: string }

/**
 * The only host object the isolate can reach. RPC exposes its prototype
 * methods; the run itself stays in a private field.
 */
class WorkflowBridge extends RpcTarget {
  readonly #run: EdgeWorkflowRun

  constructor(run: EdgeWorkflowRun) {
    super()
    this.#run = run
  }

  agent(prompt: unknown, opts: unknown, phase: unknown): Promise<BridgeReply> {
    return this.#run.bridgeAgent(prompt, opts, phase)
  }

  phase(title: unknown): void {
    this.#run.bridgePhase(title)
  }

  log(message: unknown): void {
    this.#run.bridgeLog(message)
  }
}

/** A body that still carries the Claude Code-style meta header (meta rides the request as data). */
const META_STATEMENT = /^\s*export\s+const\s+meta\b/u

/**
 * Parse the body exactly as the isolate will load it, so `start()` keeps the
 * seam's synchronous `SCRIPT_PARSE` throw (the isolate compiles only after
 * `start()` returns).
 */
function assertBodyParses(body: string, name: string): void {
  if (META_STATEMENT.test(body)) {
    throw new WorkflowError(
      'workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body',
      'SCRIPT_PARSE',
    )
  }
  let program: { body: { type: string }[] }
  try {
    program = parse(workflowBodySource(body), { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as typeof program
  } catch (error) {
    throw new WorkflowError(`workflow script "${name}" does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
  }
  if (program.body.length !== 1 || program.body[0]?.type !== 'ExportDefaultDeclaration') {
    throw new WorkflowError(`workflow script "${name}" must not close its wrapper function`, 'SCRIPT_PARSE')
  }
}

interface RunObserver {
  phase(title: string): void
  log(message: string): void
  agentStart(agent: WorkflowAgentInfo): void
  agentEnd(agent: WorkflowAgentEndInfo): void
}

interface AgentOptions {
  label?: string
  phase?: string
  schema?: ObjectJsonSchema
  provider?: string
  model?: string
}

/**
 * One live run. `result` settles exactly once and never rejects. The run owns
 * its children: cancellation aborts their shared signal, and settlement,
 * cancellation grace, and disposal dispose every child that is still registered.
 */
class EdgeWorkflowRun implements WorkflowRun {
  readonly id: WorkflowRunId
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>

  private readonly parent: Agent
  private readonly script: string
  private readonly args: unknown
  private settleResolve!: (result: WorkflowResult) => void
  private settled = false
  private began = false
  private started = 0
  private progressEvents = 0
  private activeSlots = 0
  private readonly slotWaiters: { resolve(): void, reject(error: unknown): void }[] = []
  private isolate: { worker: unknown, entrypoint: unknown } | undefined
  private cancelReason: string | undefined
  private cancelError: WorkflowError | undefined
  private graceTimer: ReturnType<typeof setTimeout> | undefined
  private readonly controller = new AbortController()
  private readonly children = new Map<SubagentRun, Promise<void> | undefined>()
  private pendingStarts = 0
  private readonly quiescenceWaiters: (() => void)[] = []
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  private inputSignal: AbortSignal | undefined
  private readonly onInputAbort = () => { this.cancel('workflow signal aborted') }
  private disposed: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    info: WorkflowRunInfo,
    request: WorkflowStartRequest,
    private readonly provider: string,
    private readonly limits: EdgeWorkflowEngineConfig,
    private readonly observer: RunObserver,
  ) {
    this.id = info.id
    this.meta = info.meta
    this.parent = request.parent
    this.script = request.script
    // args is plain JSON by the seam contract; the copy keeps script mutation away from the caller.
    this.args = request.args === undefined ? undefined : JSON.parse(JSON.stringify(request.args)) as unknown
    this.result = new Promise(resolve => { this.settleResolve = resolve })
    const signal = request.signal
    if (signal?.aborted === true) {
      this.cancel('workflow start signal already aborted')
    } else if (signal !== undefined) {
      this.inputSignal = signal
      signal.addEventListener('abort', this.onInputAbort, { once: true })
    }
  }

  /** Load the run's isolate and evaluate the script once. Called by the engine after `start()` returns. */
  begin(): void {
    if (this.began) return
    this.began = true
    if (this.settled) return
    if (this.isCancelled()) {
      this.settle(this.cancelledResult())
      return
    }
    let evaluation: Promise<unknown>
    try {
      const limits = { cpuMs: this.limits.cpuMs }
      const worker = this.limits.loader.load({
        compatibilityDate: WORKFLOW_COMPATIBILITY_DATE,
        mainModule: WORKFLOW_ENTRY_MODULE,
        modules: {
          [WORKFLOW_ENTRY_MODULE]: WORKFLOW_ENTRY_SOURCE,
          [WORKFLOW_RUNTIME_MODULE]: WORKFLOW_RUNTIME_SOURCE,
          [WORKFLOW_BODY_MODULE]: workflowBodySource(this.script),
        },
        limits,
        globalOutbound: null,
      })
      // Held before getEntrypoint() so a failure there still disposes the worker.
      this.isolate = { worker, entrypoint: undefined }
      const entrypoint = worker.getEntrypoint(undefined, { limits }) as {
        evaluate(host: WorkflowBridge, input: { args: unknown, maxItemsPerCall: number, maxTotalAgents: number }): Promise<unknown>
      }
      this.isolate.entrypoint = entrypoint
      evaluation = Promise.resolve(entrypoint.evaluate(new WorkflowBridge(this), {
        args: this.args,
        maxItemsPerCall: this.limits.maxItemsPerCall,
        maxTotalAgents: this.limits.maxTotalAgents,
      }))
    } catch (error) {
      evaluation = Promise.reject(error)
    }
    this.finish(evaluation)
  }

  cancel(reason?: string): void {
    if (this.settled || this.cancelReason !== undefined) return
    this.cancelReason = reason ?? 'workflow cancelled'
    this.cancelError = new WorkflowError(`workflow run cancelled: ${this.cancelReason}`, 'CANCELLED')
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(this.cancelError)
    this.abortChildren()
    // Terminating the isolate rejects the pending evaluation, which settles the run.
    this.terminateIsolate()
    // Backstop in case the evaluation promise never observes the termination.
    this.graceTimer = setTimeout(() => {
      this.endStrandedAgents()
      this.settle(this.cancelledResult())
      this.reapChildren()
    }, this.limits.disposeGraceMs)
  }

  dispose(): Promise<void> {
    this.disposed ??= (async () => {
      this.detachInputSignal()
      this.cancel('workflow disposed')
      this.reapChildren()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        (async () => {
          await this.result
          await this.childQuiescence()
        })(),
        new Promise<void>(resolve => { timer = setTimeout(resolve, this.limits.disposeGraceMs) }),
      ])
      clearTimeout(timer)
      this.reapChildren()
    })()
    return this.disposed
  }

  private finish(completion: Promise<unknown>): void {
    completion.then(
      envelope => {
        if (this.isCancelled()) return this.cancelledResult()
        try {
          // The runtime wraps the script's value because RPC adds a disposer to the returned object.
          const raw = (envelope as { value?: unknown } | null | undefined)?.value
          const value = raw === undefined ? null : materializeResult(raw)
          const size = jsonBytes(value)
          if (size > MAX_RESULT_BYTES) {
            return this.errorResult(`the workflow result is ${size} bytes, over the ${MAX_RESULT_BYTES}-byte limit`)
          }
          return {
            value,
            stopReason: 'completed',
            agentsStarted: this.started,
          } satisfies WorkflowResult
        } catch (error) {
          return this.errorResult(renderThrown(error))
        }
      },
      (error: unknown) => {
        if (this.isCancelled()) return this.cancelledResult()
        return this.errorResult(renderThrown(error))
      },
    ).then(result => {
      this.endStrandedAgents()
      this.settle(result)
      this.reapChildren()
      this.terminateIsolate()
    }, (error: unknown) => {
      /* Defensive: the handlers above never throw, but result must never stay pending. */
      this.settle(this.errorResult(renderThrown(error)))
      this.reapChildren()
      this.terminateIsolate()
    })
  }

  /** Dispose the entrypoint and the Dynamic Worker, ending any code still running in it. */
  private terminateIsolate(): void {
    const isolate = this.isolate
    this.isolate = undefined
    if (isolate === undefined) return
    for (const handle of [isolate.entrypoint, isolate.worker]) {
      if (handle === undefined) continue
      try {
        (handle as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
      } catch (error) {
        this.ctx.logger.warn(`edge-workflow: isolate dispose failed: ${renderThrown(error)}`)
      }
    }
  }

  /** Bridge entry for `agent()`: a reply object, because only data crosses RPC reliably. */
  async bridgeAgent(prompt: unknown, opts: unknown, scriptPhase: unknown): Promise<BridgeReply> {
    const size = jsonBytes([prompt, opts, scriptPhase])
    if (size > MAX_AGENT_REQUEST_BYTES) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: `agent() request is ${size} bytes, over the ${MAX_AGENT_REQUEST_BYTES}-byte limit` }
    }
    try {
      const phase = typeof scriptPhase === 'string' && scriptPhase.length > 0 ? scriptPhase : undefined
      return { ok: true, value: await this.agent(prompt, opts ?? undefined, phase) }
    } catch (error) {
      return error instanceof WorkflowError
        ? { ok: false, code: error.code, message: error.message }
        : { ok: false, code: 'AGENT_RESULT', message: renderThrown(error) }
    }
  }

  /** Bridge entry for `phase()`: progress narration only; the isolate tracks its current phase. */
  bridgePhase(title: unknown): void {
    if (typeof title !== 'string' || title.length === 0 || !this.admitProgress()) return
    this.observer.phase(clipProgress(title))
  }

  /** Bridge entry for `log()`. */
  bridgeLog(message: unknown): void {
    if (typeof message !== 'string' || !this.admitProgress()) return
    this.observer.log(clipProgress(message))
  }

  /** Whether one more progress event may be emitted (live run, under the per-run cap). */
  private admitProgress(): boolean {
    if (this.settled || this.isCancelled() || this.progressEvents >= this.limits.maxProgressEvents) return false
    this.progressEvents += 1
    return true
  }

  private isCancelled(): boolean {
    return this.cancelReason !== undefined
  }

  /** Every bridge call refuses work once the run is cancelled or already settled. */
  private throwIfCancelled(): void {
    if (this.cancelError !== undefined) throw this.cancelError
    if (this.settled) throw new WorkflowError('workflow run already settled', 'CANCELLED')
  }

  private async agent(rawPrompt: unknown, rawOpts: unknown, scriptPhase: string | undefined): Promise<unknown> {
    this.throwIfCancelled()
    if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
      throw new WorkflowError('agent() requires a non-empty prompt string', 'INVALID_ARGUMENT')
    }
    const opts = readAgentOptions(rawOpts)
    if (this.started >= this.limits.maxTotalAgents) {
      throw new WorkflowError(
        `this run reached its total agent cap (${this.limits.maxTotalAgents}) — a runaway-loop backstop; split the work across runs if the scale is intentional`,
        'AGENT_CAP',
      )
    }
    this.started += 1
    const seq = this.started
    const label = opts.label ?? defaultLabel(rawPrompt)
    const phase = opts.phase ?? scriptPhase
    await this.acquireSlot()
    try {
      this.throwIfCancelled()
      const run = await this.startChild(rawPrompt, label, opts)
      const info: WorkflowAgentInfo = {
        seq,
        label,
        ...phase !== undefined ? { phase } : {},
        childId: run.id as SessionId,
      }
      this.liveAgents.set(seq, info)
      this.observer.agentStart(info)
      try {
        let result
        try {
          result = await run.result
        } catch (error) {
          if (this.isCancelled()) {
            this.endAgent(info, 'cancelled')
            throw this.cancelError!
          }
          this.endAgent(info, 'failed')
          throw new WorkflowError(`child agent run failed: ${renderThrown(error)}`, 'AGENT_RESULT', { cause: error })
        }
        if (result.stopReason === 'completed') {
          if (opts.schema !== undefined) {
            if (result.structured === undefined) {
              this.endAgent(info, 'failed')
              return null
            }
            this.endAgent(info, 'completed')
            return result.structured
          }
          this.endAgent(info, 'completed')
          return outputText(result.output)
        }
        if (this.isCancelled()) {
          this.endAgent(info, 'cancelled')
          throw this.cancelError!
        }
        this.endAgent(info, 'failed')
        return null
      } finally {
        await this.disposeChild(run)
      }
    } finally {
      this.releaseSlot()
    }
  }

  /** Start one child, registering it for cancellation before the script can observe it. */
  private async startChild(prompt: string, label: string, opts: AgentOptions): Promise<SubagentRun> {
    this.pendingStarts += 1
    let run: SubagentRun
    try {
      run = await this.ctx.subagents.start(this.provider, {
        label,
        prompt: [{ type: 'text', text: prompt }],
        parent: this.parent,
        signal: this.controller.signal,
        ...opts.schema !== undefined ? { outputSchema: opts.schema } : {},
        ...opts.provider !== undefined || opts.model !== undefined
          ? {
              agentOptions: {
                ...opts.provider !== undefined ? { provider: opts.provider } : {},
                ...opts.model !== undefined ? { model: opts.model } : {},
              },
            }
          : {},
      })
      // Registered before the pending count drops, so quiescence always waits for its disposal.
      this.children.set(run, undefined)
    } catch (error) {
      if (this.isCancelled()) throw this.cancelError!
      throw new WorkflowError(`agent() could not start a child: ${renderThrown(error)}`, 'AGENT_START', { cause: error })
    } finally {
      this.pendingStarts -= 1
      this.notifyQuiescence()
    }
    if (this.isCancelled() || this.settled) {
      await this.disposeChild(run)
      throw this.cancelError ?? new WorkflowError('workflow run already settled', 'CANCELLED')
    }
    return run
  }

  private acquireSlot(): Promise<void> {
    if (this.activeSlots < this.limits.maxConcurrentAgents) {
      this.activeSlots += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.slotWaiters.push({
        resolve: () => {
          this.activeSlots += 1
          resolve()
        },
        reject,
      })
    })
  }

  private releaseSlot(): void {
    this.activeSlots -= 1
    this.slotWaiters.shift()?.resolve()
  }

  /** Emit `agent-end` once for a started agent; later reports for the same seq are dropped. */
  private endAgent(info: WorkflowAgentInfo, outcome: WorkflowAgentEndInfo['outcome']): void {
    if (!this.liveAgents.delete(info.seq)) return
    this.observer.agentEnd({ ...info, outcome })
  }

  private endStrandedAgents(): void {
    for (const info of this.liveAgents.values()) this.endAgent(info, 'cancelled')
  }

  /** Dispose one child once; concurrent callers share the same disposal. */
  private disposeChild(run: SubagentRun): Promise<void> {
    const existing = this.children.get(run)
    if (existing !== undefined) return existing
    if (!this.children.has(run)) return Promise.resolve()
    const disposal = Promise.resolve()
      .then(() => run.dispose())
      .catch((error: unknown) => {
        this.ctx.logger.warn(`edge-workflow: child dispose failed: ${renderThrown(error)}`)
      })
      .then(() => {
        this.children.delete(run)
        this.notifyQuiescence()
      })
    this.children.set(run, disposal)
    return disposal
  }

  private reapChildren(): void {
    this.abortChildren()
    for (const run of this.children.keys()) void this.disposeChild(run)
  }

  private abortChildren(): void {
    if (!this.controller.signal.aborted) this.controller.abort(this.cancelReason ?? 'workflow settled')
  }

  private notifyQuiescence(): void {
    if (this.children.size !== 0 || this.pendingStarts !== 0) return
    for (const waiter of this.quiescenceWaiters.splice(0)) waiter()
  }

  private childQuiescence(): Promise<void> {
    if (this.children.size === 0 && this.pendingStarts === 0) return Promise.resolve()
    return new Promise(resolve => { this.quiescenceWaiters.push(resolve) })
  }

  private detachInputSignal(): void {
    this.inputSignal?.removeEventListener('abort', this.onInputAbort)
    this.inputSignal = undefined
  }

  private cancelledResult(): WorkflowResult {
    return {
      value: null,
      stopReason: 'cancelled',
      error: `workflow run cancelled: ${this.cancelReason ?? 'workflow cancelled'}`,
      agentsStarted: this.started,
    }
  }

  private errorResult(error: string): WorkflowResult {
    return { value: null, stopReason: 'error', error, agentsStarted: this.started }
  }

  private settle(result: WorkflowResult): void {
    if (this.settled) return
    this.settled = true
    this.detachInputSignal()
    clearTimeout(this.graceTimer)
    this.settleResolve(result)
  }
}

function outputText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function defaultLabel(prompt: string): string {
  const newline = prompt.indexOf('\n')
  const line = newline === -1 ? prompt : prompt.slice(0, newline)
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`
}

function readAgentOptions(rawOpts: unknown): AgentOptions {
  if (rawOpts === undefined) return {}
  let opts: unknown
  try {
    opts = materialize(rawOpts, 'agent() options')
  } catch (error) {
    throw new WorkflowError(`agent() options must be plain JSON data — ${renderThrown(error)}`, 'INVALID_ARGUMENT', { cause: error })
  }
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new WorkflowError('agent() options must be an object', 'INVALID_ARGUMENT')
  }
  const record = opts as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (SUPPORTED_AGENT_OPTIONS.has(key)) continue
    const kind = DEFERRED_AGENT_OPTIONS.has(key) ? 'is deferred and not supported by this engine' : 'is not recognized'
    throw new WorkflowError(`agent() option "${key}" ${kind} (${SUPPORTED_OPTIONS_TEXT})`, 'UNSUPPORTED_OPTION')
  }
  for (const key of ['label', 'phase', 'provider', 'model']) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw new WorkflowError(`agent() option "${key}" must be a string`, 'INVALID_ARGUMENT')
    }
  }
  let schema: ObjectJsonSchema | undefined
  if (record.schema !== undefined) {
    try {
      assertObjectJsonSchema(record.schema)
      schema = record.schema
    } catch (error) {
      if (!(error instanceof JsonSchemaError)) throw error
      throw new WorkflowError(`agent() schema is outside the supported subset — ${error.message}`, 'UNSUPPORTED_SCHEMA', { cause: error })
    }
  }
  return {
    ...record.label !== undefined ? { label: record.label as string } : {},
    ...record.phase !== undefined ? { phase: record.phase as string } : {},
    ...record.provider !== undefined ? { provider: record.provider as string } : {},
    ...record.model !== undefined ? { model: record.model as string } : {},
    ...schema !== undefined ? { schema } : {},
  }
}

function resolveMaxTotalAgents(requested: number | undefined, ceiling: number): number {
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new WorkflowError('workflow maxTotalAgents must be a positive safe integer', 'INVALID_ARGUMENT')
  }
  if (requested > ceiling) {
    throw new WorkflowError(`workflow maxTotalAgents ${requested} exceeds the engine ceiling ${ceiling}`, 'INVALID_ARGUMENT')
  }
  return requested
}

/**
 * Validate caller-provided meta data and return a normalized copy. Mirrors the
 * published worker-thread engine's `validateMeta`, whose module cannot load in
 * workerd because it imports `node:vm` at the top level.
 */
export function validateMeta(value: unknown): WorkflowMeta {
  const violations: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowError('invalid meta: meta must be an object', 'META_INVALID')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!['name', 'description', 'whenToUse', 'phases'].includes(key)) {
      violations.push(`meta.${key} is not a recognized field (name/description/whenToUse/phases)`)
    }
  }
  if (typeof record.name !== 'string' || record.name.length === 0) violations.push('meta.name must be a non-empty string')
  if (typeof record.description !== 'string' || record.description.length === 0) {
    violations.push('meta.description must be a non-empty string')
  }
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') violations.push('meta.whenToUse must be a string')
  const phases: WorkflowPhase[] = []
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      violations.push('meta.phases must be an array')
    } else {
      record.phases.forEach((phase: unknown, index) => {
        if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
          violations.push(`meta.phases[${index}] must be an object`)
          return
        }
        const entry = phase as Record<string, unknown>
        for (const key of Object.keys(entry)) {
          if (!['title', 'detail', 'provider', 'model'].includes(key)) {
            violations.push(`meta.phases[${index}].${key} is not a recognized field`)
          }
        }
        if (typeof entry.title !== 'string' || entry.title.length === 0) {
          violations.push(`meta.phases[${index}].title must be a non-empty string`)
        }
        for (const key of ['detail', 'provider', 'model']) {
          if (entry[key] !== undefined && typeof entry[key] !== 'string') {
            violations.push(`meta.phases[${index}].${key} must be a string`)
          }
        }
        phases.push({
          title: entry.title as string,
          ...entry.detail !== undefined ? { detail: entry.detail as string } : {},
          ...entry.provider !== undefined ? { provider: entry.provider as string } : {},
          ...entry.model !== undefined ? { model: entry.model as string } : {},
        })
      })
    }
  }
  if (violations.length > 0) throw new WorkflowError(`invalid meta: ${violations.join('; ')}`, 'META_INVALID')
  return {
    name: record.name as string,
    description: record.description as string,
    ...record.whenToUse !== undefined ? { whenToUse: record.whenToUse as string } : {},
    ...record.phases !== undefined ? { phases } : {},
  }
}

function materializeResult(raw: unknown): unknown {
  try {
    return materialize(raw, 'workflow result')
  } catch (error) {
    throw new WorkflowError(
      `the workflow's return value is not plain JSON data — ${renderThrown(error)}. Return only JSON-serializable objects/arrays/scalars.`,
      'RESULT_UNSERIALIZABLE',
      { cause: error },
    )
  }
}

/**
 * Copy a script value into plain JSON data, failing with the offending path.
 * Mirrors the worker-thread engine's `materializeFromRealm` contract.
 */
export function materialize(value: unknown, path: string, seen = new Set<object>()): unknown {
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`${path}: non-finite numbers are not JSON data`)
      return value
    case 'object':
      break
    default:
      throw new Error(`${path}: ${typeof value} values are not JSON data`)
  }
  if (value === null) return null
  if (seen.has(value)) throw new Error(`${path}: circular references are not JSON data`)
  seen.add(value)
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${path}: symbol-keyed properties are not plain JSON data`)
    }
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) throw new Error(`${path}[${index}]: sparse arrays are not JSON data`)
        out.push(materialize(value[index], `${path}[${index}]`, seen))
      }
      for (const key of Object.keys(value)) {
        const index = Number(key)
        if (!Number.isInteger(index) || index < 0 || index >= value.length) {
          throw new Error(`${path}.${key}: arrays with non-index properties are not JSON data`)
        }
      }
      return out
    }
    const proto = Object.getPrototypeOf(value) as object | null
    if (proto !== null && Object.getPrototypeOf(proto) !== null) {
      throw new Error(`${path}: only plain objects and arrays are JSON data (exotic prototype)`)
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: materialize((value as Record<string, unknown>)[key], `${path}.${key}`, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/** UTF-8 size of a value's JSON encoding; values JSON cannot encode count as unbounded. */
function jsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 0 : new TextEncoder().encode(text).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function clipProgress(text: string): string {
  return text.length > MAX_PROGRESS_CHARS ? `${text.slice(0, MAX_PROGRESS_CHARS)}…` : text
}

/** Render a thrown value without ever throwing; the message is used because isolate stacks point at generated modules. */
function renderThrown(error: unknown): string {
  try {
    const message = (error as { message?: unknown } | null | undefined)?.message
    if (typeof message === 'string' && message.length > 0) return message
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}
