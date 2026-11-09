import { expect, it, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, RpcTarget: class {} }))
vi.mock('@cloudflare/computer', () => ({ withWorkspace: (base: unknown) => base }))
vi.mock('@cloudflare/computer/backends/worker-shell', () => ({}))
vi.mock('@cloudflare/computer/backends/container-legacy', () => ({
  LegacyContainerBackend: class {},
  withLegacyWorkspaceContainer: (base: unknown) => base,
}))
vi.mock('../src/direct-shell.ts', () => ({}))
vi.mock('../src/session-store.ts', () => ({
  EdgeSessionStoreError: class extends Error {
    constructor(readonly code: string, message: string) { super(message) }
  },
}))
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
  const dispatch = vi.spyOn(scheduleStore, 'dispatchDueSchedules').mockImplementation(() => { throw new Error('corrupt reminder') })
  let available = true
  const claim = vi.fn(() => {
    if (!available) return undefined
    available = false
    return { input: { seq: 1, sessionId: 'healthy', message: { content: [] } }, epoch: 1, deadline: Date.now() + 60_000 }
  })
  const finish = vi.fn()
  const run = vi.fn().mockResolvedValue(undefined)
  const runtime = Object.assign(Object.create(DshEdgeInstance.prototype) as object, {
    mainDriving: false, model: 'deepseek-chat', env: {},
    activeTurns: new Map(), mainStreams: new Map(), liveQueues: new Map(),
    ctx: { storage: { sql: { exec: () => ({ toArray: () => [{ session_id: 'broken', due: 0 }] }) } } },
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
    available = true
    vi.setSystemTime(101_000)
    await runtime.driveMain(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(2)
    available = true
    vi.setSystemTime(130_000)
    await runtime.driveMain(true)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledTimes(3)
    expect(finish).toHaveBeenCalledTimes(3)
    expect(retryAt).toBe(160_000)
    expect(runtime.mainDriving).toBe(false)
  } finally { log.mockRestore(); retry.mockRestore(); next.mockRestore(); dispatch.mockRestore(); vi.useRealTimers() }
})

it('recomputes the wake schedule after sleep now stops the container', async () => {
  const container = { running: true, destroy: vi.fn(async () => { container.running = false }) }
  const scheduleMainWake = vi.fn().mockResolvedValue(undefined)
  const stopNow = vi.fn(async (destroy: () => Promise<void>) => { await destroy(); return 'stopped' as const })
  const runtime = Object.assign(Object.create(DshEdgeInstance.prototype) as object, {
    containerActivity: { stopNow },
    scheduleMainWake,
  }) as unknown as { stopContainerNow(container: unknown): Promise<string> }
  await expect(runtime.stopContainerNow(container)).resolves.toBe('stopped')
  expect(container.destroy).toHaveBeenCalledOnce()
  expect(scheduleMainWake).toHaveBeenCalledOnce()
  expect(scheduleMainWake.mock.invocationCallOrder[0]).toBeGreaterThan(container.destroy.mock.invocationCallOrder[0]!)
})

it('opens the first turn only after a preset switch that began before its claim', async () => {
  const sessionId = 'session-blank'
  const switched = Promise.withResolvers<string>()
  const order: string[] = []
  const sessions = {
    selectAgentPreset: vi.fn(async () => { const preset = await switched.promise; order.push('switched'); return preset }),
    getApiSessionSummary: vi.fn(async () => ({})),
    getOrResumeAgent: vi.fn(async () => { order.push('opened'); return { agent: {} } }),
  }
  const runtime = Object.assign(Object.create(DshEdgeInstance.prototype) as object, {
    sessions, model: 'deepseek-chat', activeTurns: new Map(), presetSwitches: new Map(),
    rememberSessionListMetadata: vi.fn(),
  }) as unknown as {
    selectAgentPreset(sessionId: string, preset: string): Promise<string>
    claimTurn(sessionId: string): Promise<unknown>
  }
  const selecting = runtime.selectAgentPreset(sessionId, 'ptc')
  const claiming = runtime.claimTurn(sessionId)
  await new Promise(resolve => setTimeout(resolve, 0))
  // The claimed turn owns the session: a later switch is refused, and the
  // Agent stays closed while the earlier switch is still recomposing it.
  await expect(runtime.selectAgentPreset(sessionId, 'dsh-edge')).rejects.toMatchObject({ code: 'PRESET_LOCKED' })
  expect(sessions.getOrResumeAgent).not.toHaveBeenCalled()
  switched.resolve('ptc')
  await expect(selecting).resolves.toBe('ptc')
  await claiming
  expect(order).toEqual(['switched', 'opened'])
})


it('batches alarm work with both count and wall-time admission limits', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const next = vi.spyOn(scheduleStore, 'nextSchedule').mockReturnValue(undefined)
  let sequence = 0
  const finish = vi.fn()
  const run = vi.fn(async () => {})
  const runtime = Object.assign(Object.create(DshEdgeInstance.prototype) as object, {
    mainDriving: false, model: 'deepseek-chat', env: {}, ctx: { storage: {} },
    activeTurns: new Map(), mainStreams: new Map(), liveQueues: new Map(),
    mainQueue: { current: () => undefined, claim: () => ({ input: { seq: ++sequence, sessionId: 'healthy', message: { content: [] } }, epoch: 1, deadline: Date.now() + 60_000 }), finish },
    scheduleMainWake: vi.fn().mockResolvedValue(undefined),
    claimTurn: vi.fn().mockResolvedValue({ turn: {}, handle: {} }),
    runClaimedTurn: run, publishSessionQueue: vi.fn(),
  }) as unknown as { driveMain(fromAlarm: boolean): Promise<void> }
  try {
    await runtime.driveMain(true)
    expect(run).toHaveBeenCalledTimes(32)
    expect(finish).toHaveBeenCalledTimes(32)
    run.mockImplementation(async () => { vi.advanceTimersByTime(6_000) })
    await runtime.driveMain(true)
    expect(run).toHaveBeenCalledTimes(33)
    expect(finish).toHaveBeenCalledTimes(33)
  } finally { next.mockRestore(); vi.useRealTimers() }
})

it('does not rewrite an existing earlier alarm or delete an absent alarm', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const next = vi.spyOn(scheduleStore, 'nextSchedule').mockReturnValue(undefined)
  let scheduled: number | null = null
  let expiry: number | undefined
  let work = false
  const setAlarm = vi.fn(async (time: number) => { scheduled = time })
  const deleteAlarm = vi.fn(async () => { scheduled = null })
  const runtime = Object.assign(Object.create(DshEdgeInstance.prototype) as object, {
    sessions: { waitForInitialization: async () => {} },
    ctx: { storage: { getAlarm: async () => scheduled, setAlarm, deleteAlarm } },
    mainDriving: true,
    mainQueue: { hasWork: () => work }, closeExpiredDownlinks: () => expiry,
  }) as unknown as { scheduleMainWake(): Promise<void> }
  try {
    for(let n=0;n<20;n++)await runtime.scheduleMainWake()
    expect(deleteAlarm).not.toHaveBeenCalled()
    expiry=200_000
    for(let n=0;n<20;n++)await runtime.scheduleMainWake()
    expect(setAlarm).toHaveBeenCalledTimes(1)
    expiry=210_000
    await runtime.scheduleMainWake()
    expect(setAlarm).toHaveBeenCalledTimes(2)
    work=true
    await runtime.scheduleMainWake()
    expect(scheduled).toBe(130_000)
    vi.setSystemTime(101_000)
    await runtime.scheduleMainWake()
    expect(setAlarm).toHaveBeenCalledTimes(3)
    work=false
    expiry=undefined
    for(let n=0;n<20;n++)await runtime.scheduleMainWake()
    expect(deleteAlarm).toHaveBeenCalledTimes(1)
  } finally { next.mockRestore(); vi.useRealTimers() }
})

it('releases RPC deadlines after metadata responses and failures, preserving long-command cancellation', async () => {
  vi.useFakeTimers()
  const signals: AbortSignal[] = []
  const dispatch = vi.fn(async (_endpoint: string, _payload: unknown, signal: AbortSignal) => {
    signals.push(signal)
    return { ok: true, value: {} }
  })
  const runtime = Object.assign(Object.create(DshEdgeInstance.prototype) as object, {
    sessions: { typertRpcInterceptor: () => ({ dispatch }) },
  }) as unknown as { handleTypertRpc(request: Request, url: URL): Promise<Response> }
  const invoke = (path: string, signal?: AbortSignal) => {
    const request = new Request(`https://local.invalid/api/${path}`, {
      method: 'POST', body: JSON.stringify({ rpcId: 'fixture', payload: { args: {} } }), ...(signal ? { signal } : {}),
    })
    return runtime.handleTypertRpc(request, new URL(request.url))
  }
  try {
    for (const path of ['commands/list', 'session/modelCatalog']) {
      expect((await invoke(path)).status).toBe(200)
      expect(vi.getTimerCount()).toBe(0)
    }
    dispatch.mockRejectedValueOnce(new Error('fixture failure'))
    const failed = await (await invoke('commands/list')).json() as { result: { ok: boolean } }
    expect(failed.result.ok).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    const abort = new AbortController()
    dispatch.mockImplementationOnce(async (_endpoint, _payload, signal) => {
      abort.abort(new Error('caller disconnected'))
      expect(signal.aborted).toBe(true)
      throw signal.reason
    })
    await invoke('commands/run', abort.signal)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
  } finally { vi.useRealTimers() }
})
