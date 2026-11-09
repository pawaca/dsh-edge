import { expect, it, vi } from 'vitest'
import { MarkdownCopyBudget } from '../src/edge-markdown-copy.ts'

it('admits one formatter and holds its lease through slow reads, completion and cancellation', async () => {
  const budget = new MarkdownCopyBudget()
  const gate = Promise.withResolvers<Response>()
  const render = vi.fn(() => gate.promise)
  const signal = new AbortController().signal
  const first = budget.run(signal, render)
  const bursts = await Promise.all(Array.from({ length: 32 }, () => budget.run(signal, render)))
  expect(bursts.every(response => response.status === 429 && response.headers.get('retry-after') === '1')).toBe(true)
  expect(render).toHaveBeenCalledTimes(1)
  gate.resolve(new Response('x'.repeat(65536)))
  const response = await first
  const reader = (response.body! as ReadableStream<Uint8Array>).getReader()
  expect((await reader.read()).value?.byteLength).toBe(16384)
  expect((await budget.run(signal, render)).status).toBe(429)
  await reader.cancel()
  const second = await budget.run(signal, async () => new Response('complete'))
  expect(await second.text()).toBe('complete')
  expect((await budget.run(signal, async () => new Response(null, { status: 413 }))).status).toBe(413)
  await expect(budget.run(signal, async () => { throw new Error('render failed') })).rejects.toThrow('render failed')
  expect(await (await budget.run(signal, async () => new Response('recovered'))).text()).toBe('recovered')
})

it('expires a stalled reader and releases all timers; caller cancellation also frees admission', async () => {
  vi.useFakeTimers()
  try {
    const budget = new MarkdownCopyBudget()
    const abort = new AbortController()
    const stalled = await budget.run(abort.signal, async () => new Response('stalled'))
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(stalled.text()).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(vi.getTimerCount()).toBe(0)
    const cancelled = await budget.run(abort.signal, async () => new Response('cancelled'))
    abort.abort(new Error('client gone'))
    await expect(cancelled.text()).rejects.toThrow('client gone')
    expect(vi.getTimerCount()).toBe(0)
    const done = await budget.run(new AbortController().signal, async () => new Response('done'))
    expect(await done.text()).toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
