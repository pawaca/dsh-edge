import { describe, expect, it, vi } from 'vitest'
import { ContainerActivity } from '../src/container-activity.ts'

function tracker(sleepAfterMs = 1_000) {
  let now = 10_000
  const activity = new ContainerActivity(sleepAfterMs, () => now)
  return { activity, advance: (ms: number) => { now += ms }, now: () => now }
}

describe('container idle tracking', () => {
  it('treats an empty tracker as idle so an evicted object stops a stray container', () => {
    expect(tracker().activity.idle()).toBe(true)
  })

  it('never reports idle while a command runs, however long it takes', () => {
    const { activity, advance } = tracker()
    const release = activity.begin()
    advance(60_000)
    expect(activity.idle()).toBe(false)
    release()
    expect(activity.idle()).toBe(false)
    advance(999)
    expect(activity.idle()).toBe(false)
    advance(1)
    expect(activity.idle()).toBe(true)
  })

  it('waits for every overlapping command and ignores repeated releases', () => {
    const { activity, advance } = tracker()
    const first = activity.begin()
    const second = activity.begin()
    first()
    first()
    advance(5_000)
    expect(activity.idle()).toBe(false)
    second()
    advance(1_000)
    expect(activity.idle()).toBe(true)
  })

  it('puts the deadline one sleep window after the last settle, or from now while busy', () => {
    const { activity, advance, now } = tracker()
    const release = activity.begin()
    advance(300)
    expect(activity.deadline()).toBe(now() + 1_000)
    release()
    const settled = now()
    advance(400)
    expect(activity.deadline()).toBe(settled + 1_000)
  })

  it('moves a failed stop one full window out instead of leaving a past deadline', async () => {
    const { activity, advance, now } = tracker()
    activity.begin()()
    advance(5_000)
    expect(activity.deadline()).toBeLessThan(now())
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(activity.stopIfIdle(() => Promise.reject(new Error('stop refused')))).resolves.toBe('failed')
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
    expect(activity.idle()).toBe(false)
    expect(activity.deadline()).toBe(now() + 1_000)
  })

  it('does not stop a busy container', async () => {
    const { activity } = tracker()
    activity.begin()
    const destroy = vi.fn(() => Promise.resolve())
    await expect(activity.stopIfIdle(destroy)).resolves.toBe('busy')
    expect(destroy).not.toHaveBeenCalled()
  })

  it('holds a command that arrives during a stop until the stop settles', async () => {
    const { activity } = tracker()
    let finish!: () => void
    const stop = activity.stopIfIdle(() => new Promise<void>(resolve => { finish = resolve }))
    let admitted = false
    const admission = activity.admit().then(release => { admitted = true; return release })
    await Promise.resolve()
    await Promise.resolve()
    expect(admitted).toBe(false)
    await expect(activity.stopIfIdle(() => Promise.resolve())).resolves.toBe('busy')
    finish()
    await expect(stop).resolves.toBe('stopped')
    const release = await admission
    expect(admitted).toBe(true)
    expect(activity.idle()).toBe(false)
    release()
  })
})
