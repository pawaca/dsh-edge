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

  it('flushes an immediate item, with the batch already waiting, without the short window', async () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const deliver = vi.fn()
    const queue = new DurableEventDeliveryQueue({ maxDelayMs: 200, flush, deliver })

    queue.enqueue(1)
    queue.enqueue(2, { immediate: true })
    // No timer advance: the durable flush starts at once and covers the waiting item too.
    await vi.advanceTimersByTimeAsync(0)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith([1, 2])

    // The cancelled window does not flush again later.
    await vi.advanceTimersByTimeAsync(200)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('bounds a burst of immediate items to one immediate flush per window', async () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const deliver = vi.fn((_items: readonly number[]) => {})
    const queue = new DurableEventDeliveryQueue({ maxDelayMs: 100, flush, deliver })

    for (let item = 1; item <= 10; item++) queue.enqueue(item, { immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    // The first starts at once; the rest wait for the window, as ordinary items do.
    expect(flush).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    await queue.drain()
    expect(flush).toHaveBeenCalledTimes(2)
    expect(deliver.mock.calls.flatMap(([items]) => items)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    // A later window may flush immediately again.
    queue.enqueue(11, { immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(flush).toHaveBeenCalledTimes(3)
  })

  it('reports idle only after the durable batch has been delivered', async () => {
    const order: string[] = []
    const queue = new DurableEventDeliveryQueue({
      maxDelayMs: 200,
      flush: () => { order.push('flush') },
      deliver: () => { order.push('deliver') },
      onIdle: () => { order.push('idle') },
    })

    queue.enqueue('event')
    await queue.drain()
    expect(order).toEqual(['flush', 'deliver', 'idle'])
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

  it('advances its revision when work is accepted during an earlier drain', async () => {
    let resolveFirstFlush!: () => void
    const flush = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { resolveFirstFlush = resolve }))
      .mockResolvedValue(undefined)
    const queue = new DurableEventDeliveryQueue({ maxDelayMs: 200, flush, deliver: vi.fn() })

    queue.enqueue('first')
    const revisionBeforeDrain = queue.revision
    const drained = queue.drain()
    await Promise.resolve()
    queue.enqueue('arrived-during-drain')

    expect(queue.revision).toBe(revisionBeforeDrain + 1)
    resolveFirstFlush()
    await drained
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

    queue.enqueue('still-terminal')
    expect(queue.revision).toBe(1)
    await expect(queue.drain()).rejects.toBe(failure)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('drops an already-scheduled later batch when the active batch fails', async () => {
    vi.useFakeTimers()
    let rejectFlush!: (error: Error) => void
    const failure = new Error('slow flush failure')
    const flush = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectFlush = reject }))
    const deliver = vi.fn()
    const queue = new DurableEventDeliveryQueue({ maxDelayMs: 200, flush, deliver })

    queue.enqueue('first')
    await vi.advanceTimersByTimeAsync(200)
    queue.enqueue('second')
    await vi.advanceTimersByTimeAsync(200)
    expect(flush).toHaveBeenCalledTimes(1)

    rejectFlush(failure)
    await expect(queue.drain()).rejects.toBe(failure)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
  })
})
