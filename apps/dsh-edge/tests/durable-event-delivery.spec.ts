import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableEventDeliveryQueue } from '../src/durable-event-delivery.ts'

describe('durable event delivery queue', () => {
  afterEach(() => vi.useRealTimers())

  it('flushes one short-window batch before delivering its items in order', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const flush = vi.fn(() => { order.push('flush') })
    const deliver = vi.fn((items: readonly number[]) => {
      order.push(`deliver:${items.join(',')}`)
    })
    const queue = new DurableEventDeliveryQueue({ maxDelayMs: 200, flush, deliver })

    queue.enqueue(1)
    queue.enqueue(2)
    queue.enqueue(3)
    await vi.advanceTimersByTimeAsync(199)
    expect(flush).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await queue.drain()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['flush', 'deliver:1,2,3'])
  })

  it('does not expose a batch until its durability barrier resolves', async () => {
    let resolveFlush!: () => void
    const flush = vi.fn(() => new Promise<void>(resolve => { resolveFlush = resolve }))
    const deliver = vi.fn()
    const queue = new DurableEventDeliveryQueue({ maxDelayMs: 200, flush, deliver })

    queue.enqueue('durable-first')
    const drained = queue.drain()
    await Promise.resolve()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()

    resolveFlush()
    await drained
    expect(deliver).toHaveBeenCalledWith(['durable-first'])
  })

  it('reports a failed durability barrier without delivering the batch', async () => {
    const failure = new Error('injected flush failure')
    const deliver = vi.fn()
    const onError = vi.fn()
    const queue = new DurableEventDeliveryQueue({
      maxDelayMs: 200,
      flush: () => Promise.reject(failure),
      deliver,
      onError,
    })

    queue.enqueue('not-durable')
    await expect(queue.drain()).rejects.toBe(failure)
    expect(deliver).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(failure)
  })
})
