import { expect, it, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))
vi.mock('@cloudflare/computer', () => ({ withWorkspace: (base: unknown) => base }))
vi.mock('@cloudflare/computer/backends/worker-shell', () => ({}))
vi.mock('../src/direct-shell.ts', () => ({}))
vi.mock('../src/session-store.ts', () => ({}))
import { DshEdgeInstance } from '../src/instance.ts'
import * as scheduleStore from '../src/schedule-store.ts'
// Exercise the real driver while replacing host services, not its dispatch/claim control flow.
it('drains healthy inputs on repeated alarms despite reminder preparation failures', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let retryAt = 0
  const retry = vi.spyOn(scheduleStore, 'setScheduleRetry').mockImplementation((_storage, _id, at) => { retryAt = at })
  const next = vi.spyOn(scheduleStore, 'nextSchedule').mockImplementation(() => ({ sessionId: 'broken', due: retryAt }))
  const dispatch = vi.fn().mockRejectedValue(new Error('corrupt reminder session'))
  const claim = vi.fn(() => ({ input: { seq: 1, sessionId: 'healthy', message: { content: [] } }, epoch: 1, deadline: Date.now() + 60_000 }))
  const finish = vi.fn()
  const run = vi.fn().mockResolvedValue(undefined)
  const runtime = Object.assign(Object.create(DshEdgeInstance.prototype) as object, {
    mainDriving: false, model: 'deepseek-chat', env: {},
    activeTurns: new Map(), mainStreams: new Map(), liveQueues: new Map(),
    ctx: { storage: { sql: { exec: () => ({ toArray: () => [{ session_id: 'broken', due: 0 }] }) } } },
    sessions: { dispatchDueSchedules: dispatch },
    mainQueue: { current: () => undefined, claim, finish },
    scheduleMainWake: vi.fn().mockResolvedValue(undefined),
    claimTurn: vi.fn().mockResolvedValue({ turn: {}, handle: {} }),
    runClaimedTurn: run, publishSessionQueue: vi.fn(),
  }) as unknown as { driveMain(fromAlarm: boolean): Promise<void>; mainDriving: boolean }
  try {
    await runtime.driveMain(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenLastCalledWith(1, 1, false)
    expect(retryAt).toBe(130_000)
    vi.setSystemTime(101_000)
    await runtime.driveMain(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(2)
    vi.setSystemTime(130_000)
    await runtime.driveMain(true)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledTimes(3)
    expect(finish).toHaveBeenCalledTimes(3)
    expect(retryAt).toBe(160_000)
    expect(runtime.mainDriving).toBe(false)
  } finally { log.mockRestore(); retry.mockRestore(); next.mockRestore(); vi.useRealTimers() }
})
