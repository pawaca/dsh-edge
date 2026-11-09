import { expect, it, vi } from 'vitest'
import { requestDeadline } from '../src/edge-deadline.ts'

it('expires active work but leaves no timer or late abort after completion', () => {
  vi.useFakeTimers()
  try {
    const completed = requestDeadline(300_000)
    completed[Symbol.dispose]()
    const active = requestDeadline(30)
    vi.advanceTimersByTime(30)
    expect(active.signal.aborted).toBe(true)
    expect(active.signal.reason).toBeInstanceOf(DOMException)
    expect((active.signal.reason as DOMException).name).toBe('TimeoutError')
    active[Symbol.dispose]()
    vi.advanceTimersByTime(300_000)
    expect(completed.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    const parent = AbortSignal.abort('already cancelled')
    using cancelled = requestDeadline(30, parent)
    expect(cancelled.signal.reason).toBe('already cancelled')
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
