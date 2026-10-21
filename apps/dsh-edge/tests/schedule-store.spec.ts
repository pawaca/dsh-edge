/// <reference types="node" />
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { ScheduleId, type ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolSchedule from '@deepseek-ai/dsh-tool-schedule'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { MainSessionQueue, MAIN_QUEUE_BYTES } from '../src/main-session-queue.ts'
import { EdgeSchedule, dispatchDueSchedules, initializeSchedules, nextSchedule, setScheduleRetry } from '../src/schedule-store.ts'
import { TestDurableObjectStorage } from './main-session-queue.spec.ts'

class AlarmStorage extends TestDurableObjectStorage {
  alarm: number | null = null
  failAlarm = false
  async getAlarm() { return this.alarm }
  async setAlarm(time: number) {
    if (this.failAlarm) throw new Error('alarm write failed')
    this.alarm = time
  }

  private transactions: Promise<unknown> = Promise.resolve()

  /** Durable Object transactions run one at a time and roll back SQL and the alarm together. */
  transaction<T>(callback: () => Promise<T>): Promise<T> {
    const run = this.transactions.catch(() => undefined).then(() => this.runTransaction(callback))
    this.transactions = run
    return run
  }

  private async runTransaction<T>(callback: () => Promise<T>): Promise<T> {
    const alarm = this.alarm
    this.sql.exec('SAVEPOINT alarm_tx')
    try {
      const result = await callback()
      this.sql.exec('RELEASE alarm_tx')
      return result
    } catch (error) {
      this.sql.exec('ROLLBACK TO alarm_tx')
      this.sql.exec('RELEASE alarm_tx')
      this.alarm = alarm
      throw error
    }
  }
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
  it('reports a conflict instead of a lost write when updates or a delete overlap', async () => {
    const { schedule } = await setup()
    const record = await schedule.create(ALPHA, { prompt: 'stretch', title: 'Stretch', after_seconds: 600 })
    // Both read the same `expected`; only the first may apply.
    const [first, second] = await Promise.all([
      schedule.update({ sessionId: ALPHA, id: record.id, expected: record, title: 'First' }),
      schedule.update({ sessionId: ALPHA, id: record.id, expected: record, title: 'Second' }),
    ])
    expect(first).toMatchObject({ updated: true })
    expect(second).toEqual({ id: record.id, updated: false, code: 'schedule_conflict' })
    expect((await schedule.list({ sessionId: ALPHA }))[0]).toMatchObject({ title: 'First' })
    const [current] = await schedule.list({ sessionId: ALPHA })
    const [deleted, late] = await Promise.all([
      schedule.delete({ sessionId: ALPHA, id: record.id }),
      schedule.update({ sessionId: ALPHA, id: record.id, expected: current!, title: 'Late' }),
    ])
    expect(deleted).toEqual({ id: record.id, deleted: true })
    expect(late).toEqual({ id: record.id, updated: false, code: 'schedule_not_found' })
  })

  it('leaves no reminder or change behind when arming its wake fails', async () => {
    const { schedule, storage } = await setup()
    storage.failAlarm = true
    await expect(schedule.create(ALPHA, { prompt: 'stretch', title: 'Stretch', after_seconds: 60 })).rejects.toThrow('alarm write failed')
    expect(await schedule.list({ sessionId: ALPHA })).toEqual([])
    storage.failAlarm = false
    const record = await schedule.create(ALPHA, { prompt: 'stretch', title: 'Stretch', after_seconds: 600 })
    storage.alarm = null
    storage.failAlarm = true
    await expect(schedule.update({ sessionId: ALPHA, id: record.id, expected: record, title: 'Stretch again' })).rejects.toThrow('alarm write failed')
    expect(await schedule.list({ sessionId: ALPHA })).toEqual([record])
  })

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
    const agent = { ctx, options: {}, session: { id: ALPHA, header: {} } } as unknown as Agent
    await ctx.plugin(ToolSchedule)
    const signal = new AbortController().signal
    const create = tools.get('schedule_create', agent)!
    expect(tools.executionMode({ name: 'schedule_create', callId: ToolCallId('c'), arguments: {}, signal, agent })).toEqual({ kind: 'exclusive' })
    const created = await create.execute({ prompt: 'ping', title: 'Ping', after_seconds: 60 } as never, { agent, signal } as never)
    expect(created).toMatchObject({ title: 'Ping' })
    expect(await tools.get('schedule_list', agent)!.execute({} as never, { agent, signal } as never)).toHaveLength(1)
  })

  it('refuses a delegated subagent, which the Edge used to exclude by mounting for root agents only', async () => {
    const { ctx, tools, schedule } = await setup(true)
    await ctx.plugin(ToolSchedule)
    const child = { ctx, options: {}, session: { id: SessionId('child'), header: { delegationDepth: 1 } } } as unknown as Agent
    const signal = new AbortController().signal
    const refused = await tools.get('schedule_create', child)!.execute({ prompt: 'ping', title: 'Ping', after_seconds: 60 } as never, { agent: child, signal } as never)
    expect(refused).toMatchObject({ code: 'subagent_session' })
    expect(await schedule.list({ sessionId: SessionId('child') })).toEqual([])
  })
})

describe('delivery history and the schedule Remote', () => {
  const deliveries = (storage: AlarmStorage) => storage.sql.exec<{ task_id: string; seq: number }>('SELECT task_id, seq FROM dsh_schedule_deliveries ORDER BY task_id, seq').toArray()
  /** Deliver everything due at `now`, then empty the main queue so the next delivery has room. */
  const deliverAt = (storage: AlarmStorage, now: number) => {
    const delivered = dispatchDueSchedules(storage as never, ALPHA, now)
    storage.sql.exec('DELETE FROM dsh_runtime_inputs')
    storage.sql.exec('UPDATE dsh_runtime_slot SET pending = 0, bytes = 0')
    return delivered
  }

  it('saves each delivery with its occurrence, message, and prompt, and shows the latest on the catalog', async () => {
    const { schedule, storage, queue } = await setup()
    const one = await schedule.create(ALPHA, { prompt: 'check the build', title: 'Build', after_seconds: 60 })
    const every = await schedule.create(ALPHA, { prompt: 'drink water', title: 'Water', every_seconds: 600 })
    expect((await schedule.catalog()).every(entry => entry.lastDelivery === undefined)).toBe(true)
    const now = Date.parse(every.scheduledAt) + 1
    // The one-shot goes first and alone; the recurring batch next.
    expect(dispatchDueSchedules(storage as never, ALPHA, now)).toBe(true)
    expect(dispatchDueSchedules(storage as never, ALPHA, now)).toBe(true)
    const [oneShotInput, batchInput] = queue.pending(ALPHA)
    const deliveredAt = new Date(now).toISOString()
    const oneHistory = await schedule.history({ sessionId: ALPHA, id: one.id, limit: 20 })
    expect(oneHistory).toEqual({
      id: one.id,
      records: [{ scheduledAt: one.scheduledAt, deliveredAt, messageId: oneShotInput!.message.id, prompt: 'check the build' }],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
    })
    const everyHistory = await schedule.history({ sessionId: ALPHA, id: every.id, limit: 20 })
    expect(everyHistory).toMatchObject({ records: [{ scheduledAt: every.scheduledAt, deliveredAt, messageId: batchInput!.message.id, prompt: 'drink water' }] })
    // The catalog's last delivery is the newest saved record, as upstream's schema requires.
    const catalog = await schedule.catalog()
    for (const [task, history] of [[one, oneHistory], [every, everyHistory]] as const) {
      const { prompt: _prompt, ...receipt } = ('records' in history ? history.records[0] : undefined)!
      expect(catalog.find(entry => entry.id === task.id)?.lastDelivery).toEqual(receipt)
    }
  })

  it('pages newest first by message cursor and refuses unknown tasks, cursors, and limits', async () => {
    const { schedule, storage } = await setup()
    const every = await schedule.create(ALPHA, { prompt: 'tick', title: 'Tick', every_seconds: 600 })
    let at = Date.parse(every.scheduledAt)
    for (let index = 0; index < 5; index++, at += 600_000) expect(deliverAt(storage, at + 1)).toBe(true)
    const first = await schedule.history({ sessionId: ALPHA, id: every.id, limit: 2 })
    if (!('records' in first)) throw new Error('expected records')
    expect(first.records.map(record => record.scheduledAt)).toEqual([new Date(at - 600_000).toISOString(), new Date(at - 1_200_000).toISOString()])
    expect(first.nextBefore).toBe(first.records[1]!.messageId)
    const second = await schedule.history({ sessionId: ALPHA, id: every.id, limit: 2, before: first.records[1]!.messageId })
    if (!('nextBefore' in second) || second.nextBefore === undefined) throw new Error('expected a second cursor')
    const third = await schedule.history({ sessionId: ALPHA, id: every.id, limit: 2, before: second.nextBefore })
    expect('records' in third && third.records).toHaveLength(1)
    expect('nextBefore' in third).toBe(false)
    expect(await schedule.history({ sessionId: ALPHA, id: every.id, limit: 2, before: 'missing' as never })).toEqual({ id: every.id, code: 'delivery_cursor_not_found' })
    expect(await schedule.history({ sessionId: SessionId('beta'), id: every.id, limit: 2 })).toEqual({ id: every.id, code: 'schedule_not_found' })
    for (const limit of [0, 101, 1.5]) await expect(schedule.history({ sessionId: ALPHA, id: every.id, limit })).rejects.toThrow('limit')
  })

  it('keeps the newest 200 records within 30 days, and says when earlier ones were pruned', async () => {
    const { schedule, storage } = await setup()
    const every = await schedule.create(ALPHA, { prompt: 'tick', title: 'Tick', every_seconds: 60 })
    let at = Date.parse(every.scheduledAt)
    for (let index = 0; index < 205; index++, at += 60_000) deliverAt(storage, at + 1)
    expect(deliveries(storage)).toHaveLength(200)
    expect(deliveries(storage)[0]!.seq).toBe(5)
    expect(await schedule.history({ sessionId: ALPHA, id: every.id, limit: 1 })).toMatchObject({ earlierRecordsUnavailable: true, earlierRecordsPruned: true })
    // A delivery 31 days later drops everything older than its window.
    const late = await schedule.create(ALPHA, { prompt: 'later', title: 'Later', every_seconds: 60 })
    deliverAt(storage, Date.parse(late.scheduledAt) + 31 * 86_400_000)
    expect(deliveries(storage).filter(row => row.task_id === every.id)).toHaveLength(1)
  })

  it('reads a task stored before delivery history as having earlier records unavailable', async () => {
    const { schedule, storage } = await setup()
    const every = await schedule.create(ALPHA, { prompt: 'tick', title: 'Tick', every_seconds: 600 })
    storage.sql.exec('UPDATE dsh_schedule_tasks SET delivery = NULL')
    expect(await schedule.history({ sessionId: ALPHA, id: every.id, limit: 5 })).toMatchObject({ records: [], earlierRecordsUnavailable: true, earlierRecordsPruned: false })
    deliverAt(storage, Date.parse(every.scheduledAt) + 1)
    expect(await schedule.history({ sessionId: ALPHA, id: every.id, limit: 5 })).toMatchObject({ earlierRecordsUnavailable: true, earlierRecordsPruned: false })
    expect((await schedule.catalog())[0]?.lastDelivery).toBeDefined()
  })

  it('adds the summary column to a task table from an earlier release', async () => {
    const storage = new AlarmStorage()
    storage.sql.exec(`CREATE TABLE dsh_schedule_tasks (session_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
      active INTEGER NOT NULL, due INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(session_id, id))`)
    initializeSchedules(storage as never)
    initializeSchedules(storage as never)
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('dsh_schedule_tasks') WHERE name = 'delivery'").toArray()).toHaveLength(1)
    storage.close()
  })

  it('removes saved deliveries with their task: delete, archive, and the ended-task cap', async () => {
    const { schedule, storage, ctx } = await setup()
    const deleted = await schedule.create(ALPHA, { prompt: 'a', title: 'A', every_seconds: 600 })
    deliverAt(storage, Date.parse(deleted.scheduledAt) + 1)
    expect(deliveries(storage)).toHaveLength(1)
    await schedule.delete({ sessionId: ALPHA, id: deleted.id })
    expect(deliveries(storage)).toEqual([])

    const archived = await schedule.create(ALPHA, { prompt: 'b', title: 'B', every_seconds: 600 })
    deliverAt(storage, Date.parse(archived.scheduledAt) + 1)
    await ctx.parallel('workspace/session-stop', { sessionId: ALPHA })
    expect(deliveries(storage)).toEqual([])

    // Only the newest 128 ended tasks are kept; older ones leave no history behind.
    const ended: ScheduleRecord[] = []
    for (let index = 0; index < 130; index++) {
      const record = await schedule.create(ALPHA, { prompt: `once ${String(index)}`, title: 'Once', after_seconds: 60 + index })
      ended.push(record)
      deliverAt(storage, Date.parse(record.scheduledAt) + 1)
    }
    const kept = new Set((await schedule.catalog()).map(entry => entry.id))
    expect(kept.size).toBe(128)
    expect(new Set(deliveries(storage).map(row => row.task_id))).toEqual(kept)
  })

  it('announces each committed change, and nothing for a no-op or a miss', async () => {
    const { schedule, storage, ctx } = await setup()
    let changes = 0
    ctx.on('schedule/changed', () => { changes += 1 })
    const record = await schedule.create(ALPHA, { prompt: 'a', title: 'A', every_seconds: 600 })
    expect(changes).toBe(1)
    await schedule.update({ sessionId: ALPHA, id: record.id, expected: record, title: 'A' })
    expect(changes).toBe(1)
    const updated = await schedule.update({ sessionId: ALPHA, id: record.id, expected: record, title: 'B' })
    expect(changes).toBe(2)
    await schedule.delete({ sessionId: ALPHA, id: ScheduleId('missing') })
    expect(changes).toBe(2)
    await schedule.delete({ sessionId: ALPHA, id: record.id })
    expect(changes).toBe(3)
    await schedule.create(ALPHA, { prompt: 'b', title: 'B', after_seconds: 60 })
    await ctx.parallel('workspace/session-stop', { sessionId: ALPHA })
    expect(changes).toBe(5)
    await ctx.parallel('workspace/session-stop', { sessionId: ALPHA })
    expect(changes).toBe(5)
    // A throwing listener does not fail the change that already landed.
    ctx.on('schedule/changed', () => { throw new Error('listener failed') })
    await expect(schedule.create(ALPHA, { prompt: 'c', title: 'C', after_seconds: 60 })).resolves.toMatchObject({ title: 'C' })
    expect('record' in updated).toBe(true)
    void storage
  })
})

describe('legacy reminder import', () => {
  it('imports active 0.18 reminders once with generated titles and drops the old tables', async () => {
    const storage = new AlarmStorage()
    new MainSessionQueue(storage as never)
    const now = Date.now()
    // Earlier releases numbered reminders per session: both sessions hold a schedule-1.
    const legacy = { id: 'schedule-1', kind: 'after', prompt: 'Review the deploy\nthen report back', afterSeconds: 600, scheduledAt: new Date(now + 600_000).toISOString() }
    const every = { id: 'schedule-1', kind: 'every', prompt: 'x'.repeat(300), everySeconds: 3600, scheduledAt: new Date(now + 3_600_000).toISOString() }
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
    // Ending alpha's schedule-1 leaves beta's schedule-1 active.
    expect(dispatchDueSchedules(storage as never, 'alpha', Date.parse(legacy.scheduledAt) + 1)).toBe(true)
    expect(await schedule.list({ sessionId: ALPHA })).toEqual([])
    expect(await schedule.list({ sessionId: SessionId('beta') })).toEqual([imported])
    expect(await schedule.delete({ sessionId: SessionId('beta'), id: imported!.id })).toEqual({ id: 'schedule-1', deleted: true })
    expect((await schedule.catalog()).map(entry => [entry.sessionId, entry.id, entry.status])).toEqual([['alpha', 'schedule-1', 'inactive']])
  })
})
