import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { ShortToolPool, installShortToolPool } from '../src/short-tool-pool.ts'
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
describe('short tool pool', () => {
  it('queues FIFO and keeps the permit through cancellation cleanup', async () => {
    const pool = new ShortToolPool(1)
    const controller = new AbortController()
    const cleanup = Promise.withResolvers<void>()
    const started: string[] = []
    const first = pool.run(controller.signal, async signal => {
      started.push('first')
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      await cleanup.promise
    })
    const firstFailure = expect(first).rejects.toThrow()
    await tick()
    const second = pool.run(new AbortController().signal, async () => { started.push('second') })
    controller.abort(new Error('cancelled'))
    await tick()
    expect(pool.snapshot).toEqual({ active: 1, waiting: 1, capacity: 1 })
    expect(started).toEqual(['first'])
    cleanup.resolve()
    await firstFailure
    await second
    expect(started).toEqual(['first', 'second'])
    expect(pool.snapshot.active).toBe(0)
  })
  it('removes cancelled and expired waiters without leaking permits', async () => {
    const pool = new ShortToolPool(1, 2, 15, 1000)
    const hold = Promise.withResolvers<void>()
    const first = pool.run(new AbortController().signal, () => hold.promise)
    const abort = new AbortController()
    const cancelled = pool.run(abort.signal, async () => { throw new Error('must not start') })
    const rejected = expect(cancelled).rejects.toThrow('stop')
    abort.abort(new Error('stop'))
    await rejected
    await expect(pool.run(new AbortController().signal, async () => {})).rejects.toThrow('queue deadline')
    hold.resolve()
    await first
    expect(pool.snapshot).toEqual({ active: 0, waiting: 0, capacity: 1 })
  })
  it('execution timeout aborts the real callback before returning a permit', async () => {
    const pool = new ShortToolPool(1, 2, 100, 10)
    let stopped = false
    await expect(pool.run(new AbortController().signal, signal => new Promise<void>(resolve => {
      signal.addEventListener('abort', () => { stopped = true; resolve() }, { once: true })
    }))).rejects.toThrow('execution deadline')
    expect(stopped).toBe(true)
    expect(pool.snapshot.active).toBe(0)
  })
})

describe('installShortToolPool middleware', () => {
  it('exempts the subagent tool from the pool while ordinary tools enter it', async () => {
    const ctx = new Context()
    await ctx.plugin(ToolRuntime)
    const pool = installShortToolPool(ctx)
    const signals: Record<string, AbortSignal> = {}
    ctx.on('tools/execute', async (exec, next) => {
      signals[exec.name] = exec.signal
      return next()
    })
    const dispatch = (ctx as { waterfall(...args: unknown[]): unknown }).waterfall.bind(ctx) as
      (thisArg: unknown, name: string, exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const mockExec = (name: string) => ({
      callId: ToolCallId(`call-${name}`), rootCallId: ToolCallId(`call-${name}`),
      name, arguments: {}, signal: new AbortController().signal,
      token: Symbol(name),
    })
    const done = () => Promise.resolve({ content: [], isError: false })
    try {
      await Promise.all([
        dispatch(ctx, 'tools/execute', mockExec('bash'), done),
        dispatch(ctx, 'tools/execute', mockExec('subagent'), done),
      ])
      expect(pool.snapshot.active).toBe(0)
      expect(signals.bash).not.toBe(signals.subagent)
    } finally { await ctx.fiber.dispose() }
  })
})
