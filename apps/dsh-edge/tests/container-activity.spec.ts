import { describe, expect, it } from 'vitest'
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
})
