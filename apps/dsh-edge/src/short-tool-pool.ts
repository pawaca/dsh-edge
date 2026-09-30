/** FIFO cooperative short-tool budget. Permits survive abort until cleanup settles. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'

export class ShortToolPool {
  private active = 0
  private readonly waiting: { wake(): void }[] = []
  constructor(readonly capacity = 2, readonly maxWaiting = 32, readonly queueMs = 30_000, readonly executionMs = 60_000) {}
  get snapshot() { return { active: this.active, waiting: this.waiting.length, capacity: this.capacity } }
  private async acquire(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (this.active < this.capacity) { this.active++; return }
    if (this.waiting.length >= this.maxWaiting) throw new Error('Short tool queue is full.')
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        const index = this.waiting.indexOf(entry)
        if (index >= 0) this.waiting.splice(index, 1)
        if (error === undefined) resolve()
        else reject(error)
      }
      const abort = () => finish(abortError(signal))
      const entry = { wake: () => finish() }
      const timer = setTimeout(() => finish(new Error('Short tool queue deadline exceeded.')), this.queueMs)
      this.waiting.push(entry)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  async run<T>(signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.acquire(signal)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Short tool execution deadline exceeded.')), this.executionMs)
    const combined = AbortSignal.any([signal, controller.signal])
    try {
      throwIfAborted(combined)
      const result = await execute(combined)
      // A deadline fails the call; a caller abort keeps the result, which the
      // upstream runtime turns into its own cancellation result.
      if (controller.signal.aborted) throw abortError(controller.signal)
      return result
    } finally {
      clearTimeout(timer)
      this.release()
    }
  }
  private release(): void {
    const next = this.waiting[0]
    if (next === undefined) this.active--
    else next.wake()
  }
  /** Bound background streams while retaining the upstream cancellation contract. */
  async *stream<T>(signal: AbortSignal, next: () => AsyncIterable<T>): AsyncIterable<T> {
    await this.acquire(signal)
    try { throwIfAborted(signal); yield* next() }
    finally { this.release() }
  }

}

/**
 * Agent cancellation aborts with a plain reason object (`{ kind: 'user' }`),
 * which upstream renders as `Error: [object Object]`; throw a readable Error.
 */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('tool call aborted', { cause: reason })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

// The subagent and workflow tools run child agents that own their own turn
// budgets, and the question and plan-review tools wait for the owner to
// answer; applying the short-tool execution deadline would kill them at 60 s.
const LONG_TOOLS = new Set(['subagent', 'workflow', 'ask_user_question', 'exit_plan_mode'])

/** Own one root permit; nested dispatch inherits its deadline instead of deadlocking. */
export function installShortToolPool(ctx: Context): ShortToolPool {
  const pool = new ShortToolPool()
  const titles = new ShortToolPool(1, 2, 5_000)
  ctx.on('llm/stream', (options, next) => options.purpose === 'session-title'
    ? titles.stream(options.signal ?? new AbortController().signal, next)
    : next(), { global: true })
  const roots = new Map<ToolExecutionToken, AbortSignal>()
  ctx.on('tools/execute', async (exec, next) => {
    const inherited = exec.parent === undefined ? undefined : roots.get(exec.parent)
    const original = exec.signal
    const invoke = async (signal: AbortSignal) => {
      exec.signal = signal
      roots.set(exec.token, signal)
      try { return await next() }
      finally { roots.delete(exec.token); exec.signal = original }
    }
    if (inherited !== undefined) return invoke(AbortSignal.any([original, inherited]))
    if (LONG_TOOLS.has(exec.name)) return invoke(original)
    return pool.run(original, invoke)
  }, { global: true, prepend: true })
  return pool
}
