/// <reference types="node" />
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { registerScheduleTools, ScheduleId, type ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { MainSessionQueue, MAIN_QUEUE_BYTES } from '../src/main-session-queue.ts'
import { EdgeSchedule, dispatchDueSchedules, initializeSchedules, nextSchedule, setScheduleRetry } from '../src/schedule-store.ts'
import { TestDurableObjectStorage } from './main-session-queue.spec.ts'

class AlarmStorage extends TestDurableObjectStorage {
  alarm: number | null = null
  async getAlarm() { return this.alarm }
  async setAlarm(time: number) { this.alarm = time }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop() })

async function setup(withTools = false) {
  const storage = new AlarmStorage()
  const queue = new MainSessionQueue(storage as never)
  const ctx = new Context()
  ctx.provide('agents', { roots: () => [] } as never)
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} } as never)
  const tools = withTools ? new ToolRuntime(ctx) : ctx.provide('tools', {} as never)
  const fiber = await ctx.plugin(EdgeSchedule, { storage: storage as never })
  cleanup.push(async () => { await fiber.dispose(); storage.close() })
  const schedule = ctx.get('schedule') as unknown as EdgeSchedule
  return { storage, queue, ctx, schedule, tools: tools as ToolRuntime }
}

const ALPHA = SessionId('alpha')

describe('Edge schedule service', () => {
  it('creates, lists, and deletes tasks in the owning session only', async () => {
    const { schedule, storage } = await setup()
    const record = await schedule.create(ALPHA, { prompt: 'stretch', title: 'Stretch', after_seconds: 60 })
    expect(record).toMatchObject({ kind: 'after', title: 'Stretch', prompt: 'stretch' })
    expect(storage.alarm).toBe(Date.parse(record.scheduledAt))
    expect(await schedule.list({ sessionId: ALPHA })).toEqual([record])
    expect(await schedule.list({ sessionId: SessionId('beta') })).toEqual([])
    expect(await schedule.delete({ sessionId: SessionId('beta'), id: record.id })).toEqual({ id: record.id, deleted: false, code: 'schedule_not_found' })
    expect(await schedule.delete({ sessionId: ALPHA, id: record.id })).toEqual({ id: record.id, deleted: true })
    expect(await schedule.catalog()).toEqual([])
  })

  it('enforces the selector, active-count, and prompt budgets', async () => {
    const { schedule } = await setup()
    await expect(schedule.create(ALPHA, { prompt: 'x', title: 'X', after_seconds: 60, every_seconds: 600 })).rejects.toMatchObject({ code: 'invalid_selector' })
    await expect(schedule.create(ALPHA, { prompt: 'x'.repeat(5000), title: 'X', after_seconds: 60 })).rejects.toMatchObject({ code: 'invalid_prompt' })
    await expect(schedule.create(ALPHA, { prompt: 'x', title: ' ', after_seconds: 60 })).rejects.toMatchObject({ code: 'invalid_prompt' })
    for (let n = 0; n < 128; n++) await schedule.create(ALPHA, { prompt: `r${n}`, title: `R${n}`, after_seconds: 60 })
    await expect(schedule.create(ALPHA, { prompt: 'one more', title: 'More', after_seconds: 60 })).rejects.toMatchObject({ code: 'invalid_rule' })
  })

  it('updates with upstream compare-and-keep semantics', async () => {
    const { schedule } = await setup()
    const daily = await schedule.create(ALPHA, { prompt: 'stand up', title: 'Standup', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } })
    const stale = { ...daily, prompt: 'changed elsewhere' } as ScheduleRecord
    expect(await schedule.update({ sessionId: ALPHA, id: daily.id, expected: stale, title: 'New' })).toEqual({ id: daily.id, updated: false, code: 'schedule_conflict' })
    // The same normalized rule keeps the committed target; only the name changes.
    const renamed = await schedule.update({ sessionId: ALPHA, id: daily.id, expected: daily, title: 'Daily standup', change: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } } })
    expect(renamed).toMatchObject({ updated: true, record: { title: 'Daily standup', scheduledAt: daily.scheduledAt } })
    const current = (renamed as { record: ScheduleRecord }).record
    expect(await schedule.update({ sessionId: ALPHA, id: daily.id, expected: current })).toEqual({ id: daily.id, updated: false, record: current })
    const moved = await schedule.update({ sessionId: ALPHA, id: daily.id, expected: current, change: { kind: 'every', every_seconds: 3600 } })
    expect(moved).toMatchObject({ updated: true, record: { kind: 'every', everySeconds: 3600, title: 'Daily standup' } })
    expect(await schedule.update({ sessionId: ALPHA, id: daily.id, expected: current, change: { kind: 'every' } as never })).toMatchObject({ code: 'schedule_conflict' })
    const latest = (moved as { record: ScheduleRecord }).record
    expect(await schedule.update({ sessionId: ALPHA, id: daily.id, expected: latest, change: { kind: 'every' } as never })).toMatchObject({ code: 'invalid_rule' })
    expect(await schedule.update({ sessionId: ALPHA, id: ScheduleId('schedule-missing'), expected: latest })).toMatchObject({ code: 'schedule_not_found' })
  })

  it('queues a due one-shot before recurring reminders and ends it atomically', async () => {
    const { schedule, storage, queue } = await setup()
    const one = await schedule.create(ALPHA, { prompt: 'check the build', title: 'Build', after_seconds: 60 })
    const every = await schedule.create(ALPHA, { prompt: 'drink water', title: 'Water', every_seconds: 600 })
    const now = Date.parse(every.scheduledAt) + 1
    expect(dispatchDueSchedules(storage as never, ALPHA, now)).toBe(true)
    const [input] = queue.pending(ALPHA)
    expect(input!.message.source).toEqual({ kind: 'schedule' })
    expect(JSON.stringify(input!.message.content)).toContain('check the build')
    expect((await schedule.catalog()).map(entry => [entry.id, entry.status])).toEqual(expect.arrayContaining([[one.id, 'inactive'], [every.id, 'active']]))
    expect(await schedule.update({ sessionId: ALPHA, id: one.id, expected: one, title: 'x' })).toMatchObject({ code: 'schedule_ended' })

    expect(dispatchDueSchedules(storage as never, ALPHA, now)).toBe(true)
    expect(queue.pending(ALPHA)).toHaveLength(2)
    expect(JSON.stringify(queue.pending(ALPHA)[1]!.message.content)).toContain('drink water')
    const [advanced] = await schedule.list({ sessionId: ALPHA })
    expect(Date.parse(advanced!.scheduledAt)).toBeGreaterThan(now)
    expect(dispatchDueSchedules(storage as never, ALPHA, now)).toBe(false)
  })

  it('leaves reminders due when the main queue is full and skips paused sessions', async () => {
    const { schedule, storage, queue } = await setup()
    const record = await schedule.create(ALPHA, { prompt: 'blocked', title: 'Blocked', after_seconds: 60 })
    // Leave less room than any framed reminder needs.
    const empty = createUserMessage({ content: [{ type: 'text', text: '' }], source: { kind: 'user' } })
    const large = { ...empty, content: [{ type: 'text' as const, text: 'x'.repeat(MAIN_QUEUE_BYTES - new TextEncoder().encode(JSON.stringify(empty)).byteLength - 64) }] }
    queue.enqueue('paused-session', large.id, 'paused', large)
    storage.sql.exec("UPDATE dsh_runtime_ready SET paused = 1 WHERE session_id = 'paused-session'")
    const now = Date.parse(record.scheduledAt) + 1
    expect(dispatchDueSchedules(storage as never, ALPHA, now)).toBe(false)
    expect(await schedule.list({ sessionId: ALPHA })).toEqual([record])
    expect(queue.pending(ALPHA)).toHaveLength(0)
  })

  it('does not wake a crash-paused session for its reminders', async () => {
    const { schedule, storage, queue } = await setup()
    await schedule.create(ALPHA, { prompt: 'paused', title: 'Paused', after_seconds: 60 })
    expect(nextSchedule(storage as never)?.sessionId).toBe(ALPHA)
    const recovery = createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } })
    queue.enqueue(ALPHA, recovery.id, 'recovery', recovery)
    storage.sql.exec('UPDATE dsh_runtime_ready SET paused = 1 WHERE session_id = ?', ALPHA)
    expect(nextSchedule(storage as never)).toBeUndefined()
  })

  it('isolates retry deadlines per session and prunes them with the last task', async () => {
    const { schedule, storage } = await setup()
    const records = new Map<string, ScheduleRecord>()
    for (const id of ['broken', 'healthy']) records.set(id, await schedule.create(SessionId(id), { prompt: id, title: id, after_seconds: 60 }))
    const due = Math.max(...[...records.values()].map(record => Date.parse(record.scheduledAt)))
    setScheduleRetry(storage as never, 'broken', due + 30_000)
    expect(nextSchedule(storage as never)?.sessionId).toBe('healthy')
    initializeSchedules(storage as never)
    expect(nextSchedule(storage as never)?.sessionId).toBe('healthy')
    await schedule.delete({ sessionId: SessionId('broken'), id: records.get('broken')!.id })
    setScheduleRetry(storage as never, 'missing-session', due + 30_000)
    expect(storage.sql.exec('SELECT * FROM dsh_schedule_retry').toArray()).toEqual([])
  })

  it('stops a session\'s active tasks when the workspace archives it', async () => {
    const { schedule, ctx } = await setup()
    await schedule.create(ALPHA, { prompt: 'later', title: 'Later', after_seconds: 60 })
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId: ALPHA }, () => Promise.resolve([]))
    expect(activity).toEqual([{ kind: 'schedule', items: [expect.objectContaining({ label: 'Later' })] }])
    await ctx.parallel('workspace/session-stop', { sessionId: ALPHA })
    expect(await schedule.list({ sessionId: ALPHA })).toEqual([])
  })

  it('serves the upstream tools as exclusive calls bound to the agent session', async () => {
    const { ctx, tools } = await setup(true)
    const agent = { ctx, session: { id: ALPHA } } as unknown as Agent
    const dispose = registerScheduleTools(ctx, ctx, agent)
    cleanup.unshift(async () => { dispose() })
    const signal = new AbortController().signal
    const create = tools.get('schedule_create', agent)!
    expect(tools.executionMode({ name: 'schedule_create', callId: ToolCallId('c'), arguments: {}, signal, agent })).toEqual({ kind: 'exclusive' })
    const created = await create.execute({ prompt: 'ping', title: 'Ping', after_seconds: 60 } as never, { agent, signal } as never)
    expect(created).toMatchObject({ title: 'Ping' })
    expect(await tools.get('schedule_list', agent)!.execute({} as never, { agent, signal } as never)).toHaveLength(1)
  })
})

describe('legacy reminder import', () => {
  it('imports active 0.18 reminders once with generated titles and drops the old tables', async () => {
    const storage = new AlarmStorage()
    new MainSessionQueue(storage as never)
    const now = Date.now()
    const legacy = { id: 'schedule-legacy', kind: 'after', prompt: 'Review the deploy\nthen report back', afterSeconds: 600, scheduledAt: new Date(now + 600_000).toISOString() }
    const every = { id: 'schedule-every', kind: 'every', prompt: 'x'.repeat(300), everySeconds: 3600, scheduledAt: new Date(now + 3_600_000).toISOString() }
    storage.loadFixture(`CREATE TABLE dsh_schedule_active (session_id TEXT NOT NULL, schedule_id TEXT NOT NULL, record TEXT NOT NULL, due INTEGER NOT NULL, created_seq INTEGER NOT NULL, PRIMARY KEY(session_id,schedule_id));
      CREATE TABLE dsh_runtime_schedule_reservation (id INTEGER PRIMARY KEY CHECK(id = 1), bytes INTEGER NOT NULL);`)
    storage.sql.exec('INSERT INTO dsh_schedule_active VALUES (?,?,?,?,?)', 'alpha', legacy.id, JSON.stringify(legacy), Date.parse(legacy.scheduledAt), 3)
    storage.sql.exec('INSERT INTO dsh_schedule_active VALUES (?,?,?,?,?)', 'beta', every.id, JSON.stringify(every), Date.parse(every.scheduledAt), 7)
    initializeSchedules(storage as never)
    initializeSchedules(storage as never)
    const tables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dsh_schedule_active','dsh_runtime_schedule_reservation')").toArray()
    expect(tables).toEqual([])
    const ctx = new Context()
    ctx.provide('agents', { roots: () => [] } as never)
    ctx.provide('tools', {} as never)
    const fiber = await ctx.plugin(EdgeSchedule, { storage: storage as never })
    cleanup.push(async () => { await fiber.dispose(); storage.close() })
    const schedule = ctx.get('schedule') as unknown as EdgeSchedule
    expect(await schedule.list({ sessionId: ALPHA })).toEqual([{ ...legacy, title: 'Review the deploy' }])
    const [imported] = await schedule.list({ sessionId: SessionId('beta') })
    expect(imported!.title).toHaveLength(120)
    expect(nextSchedule(storage as never)).toEqual({ sessionId: 'alpha', due: Date.parse(legacy.scheduledAt) })
  })
})
