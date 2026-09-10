import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
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
  function poolHarness() {
    const ctx = new Context()
    const pool = installShortToolPool(ctx)
    const dispatch = (ctx as { waterfall(...args: unknown[]): unknown }).waterfall.bind(ctx) as
      (thisArg: unknown, name: string, exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const mockExec = (name: string) => ({
      callId: ToolCallId(`call-${name}`), rootCallId: ToolCallId(`call-${name}`),
      name, arguments: {}, signal: new AbortController().signal,
      token: Symbol(name),
    })
    return { ctx, pool, dispatch, mockExec }
  }

  it('ordinary root tool acquires a pool permit during execution', async () => {
    const { ctx, pool, dispatch, mockExec } = poolHarness()
    const gate = Promise.withResolvers<void>()
    try {
      const running = dispatch(ctx, 'tools/execute', mockExec('bash'), () => gate.promise)
      await tick()
      expect(pool.snapshot.active).toBe(1)
      gate.resolve()
      await running
      expect(pool.snapshot.active).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('subagent tool does not acquire a pool permit', async () => {
    const { ctx, pool, dispatch, mockExec } = poolHarness()
    const gate = Promise.withResolvers<void>()
    try {
      const running = dispatch(ctx, 'tools/execute', mockExec('subagent'), () => gate.promise)
      await tick()
      expect(pool.snapshot.active).toBe(0)
      gate.resolve()
      await running
    } finally { await ctx.fiber.dispose() }
  })
})
