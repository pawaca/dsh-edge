/// <reference types="node" />

import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { createAfterScheduleRecord, createEveryScheduleRecord, ScheduleId } from '@deepseek-ai/dsh-schedule'
import { nextSchedule, dueScheduleChanges, reserveScheduleAdmission, scheduleWakeTime, setScheduleRetry, initializeSchedules } from '../src/schedule-store.ts'
import { MainSessionQueue } from '../src/main-session-queue.ts'
import DurableObjectSessionPersistence from '../src/do-session-persistence.ts'

/** Minimal Node-backed implementation of the DO synchronous SQL surface. */
class TestDurableObjectStorage {
  private readonly db = new DatabaseSync(':memory:')
  private eventInsertFailures = 0
  alarm: number | null = null
  failAlarm = false
  async getAlarm() { return this.alarm }
  async setAlarm(time: number) {
    if (this.failAlarm) throw new Error('injected alarm failure')
    this.alarm = time
  }
  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN')
    const alarm = this.alarm
    try {
      const result = await callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.alarm = alarm
      throw error
    }
  }
  readonly queries: string[] = []

  sql = {
    exec: <T extends TestRow = TestRow>(
      query: string,
      ...bindings: SQLInputValue[]
    ): TestCursor<T> => {
      this.queries.push(query)
      if (/INSERT INTO dsh_session_events/u.test(query) && this.eventInsertFailures > 0) {
        this.eventInsertFailures -= 1
        throw new Error('injected event insert failure')
      }
      const statement = this.db.prepare(query)
      if (/^SELECT\b/i.test(query.trimStart())) {
        const rows = statement.all(...bindings) as T[]
        return cursor(rows, Object.keys(rows[0] ?? {}), 0)
      }
      const result = statement.run(...bindings)
      return cursor([], [], Number(result.changes))
    },
  }

  transactionSync<T>(callback: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  failNextEventInsert(): void {
    this.eventInsertFailures += 1
  }

  loadFixture(source: string): void {
    this.db.exec(source)
  }

  close() {
    this.db.close()
  }
}

type TestRow = Record<string, SQLOutputValue>

interface TestCursor<T extends TestRow> extends Iterable<T> {
  readonly columnNames: string[]
  readonly rowsRead: number
  readonly rowsWritten: number
  toArray(): T[]
}

function cursor<T extends TestRow>(
  rows: T[],
  columnNames: string[],
  rowsWritten: number,
): TestCursor<T> {
  return {
    columnNames,
    rowsRead: rows.length,
    rowsWritten,
    toArray: () => [...rows],
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  }
}

describe('durable-object bounded event pages', () => {
  it('preserves flushed schedules when repairing a normally interrupted turn', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('interrupted-schedule')
    const meta: SessionHeader = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
    const record = createAfterScheduleRecord(ScheduleId('schedule-1'), 'keep this reminder', 300, Date.now())
    try {
      await persistence.appendBatch({ meta, inheritedEventCount: SessionLogOffset(0) }, [
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        { type: 'schedule/change', seq: SessionSeq(1), time: 2, data: { version: 1, operation: 'create', schedule: record } },
      ], false)
      expect((await persistence.loadStored(id))?.tornMarker).toBeUndefined()
      const restored = await persistence.load(id)
      expect(restored.events.some(event => event.type === 'schedule/change')).toBe(true)
      expect(restored.events.some(event => event.type === 'turn/end')).toBe(true)
      expect(nextSchedule(storage as never)?.sessionId).toBe(id)
    } finally { await fiber.dispose(); storage.close() }
  })

  it('rebuilds torn creates/deletes atomically and refuses to replay a torn dispatch', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const queue = new MainSessionQueue(storage as never)
    const now = Date.now()
    const record = createAfterScheduleRecord(ScheduleId('schedule-1'), 'repair reminder', 300, now)
    const metadata = (id: string) => ({ meta: { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false as const }, inheritedEventCount: SessionLogOffset(0) })
    const create = (seq: number): SessionEvent<'schedule/change'> => ({ type: 'schedule/change', seq: SessionSeq(seq), time: now, data: { version: 1, operation: 'create', schedule: record } })
    try {
      await persistence.appendBatch(metadata('torn-create'), [
        { type: 'turn/start', seq: SessionSeq(0), time: now, data: { turn: 1 } }, create(1),
      ], false)
      storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = 'torn-create' AND seq = 0")
      expect((await persistence.loadStored(SessionId('torn-create')))?.tornMarker).toBe(0)
      await persistence.load(SessionId('torn-create'))
      expect(nextSchedule(storage as never)).toBeUndefined()

      await persistence.appendBatch(metadata('torn-delete'), [create(0),
        { type: 'turn/start', seq: SessionSeq(1), time: now, data: { turn: 1 } },
        { type: 'schedule/change', seq: SessionSeq(2), time: now, data: { version: 1, operation: 'delete', id: record.id } },
      ], false)
      storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = 'torn-delete' AND seq = 1")
      storage.alarm = null
      storage.failAlarm = true
      await expect(persistence.load(SessionId('torn-delete'))).rejects.toThrow('alarm failure')
      expect(nextSchedule(storage as never)).toBeUndefined()
      expect((await persistence.loadStored(SessionId('torn-delete')))?.tornMarker).toBe(1)
      storage.failAlarm = false
      await persistence.load(SessionId('torn-delete'))
      expect(nextSchedule(storage as never)?.sessionId).toBe('torn-delete')
      expect(storage.alarm).toBe(Date.parse(record.scheduledAt))

      await persistence.appendBatch(metadata('torn-dispatch'), [create(0)], false)
      await persistence.appendBatch(metadata('torn-dispatch'), [
        { type: 'schedule/change', seq: SessionSeq(1), time: now, data: { version: 1, operation: 'dispatch', id: record.id } },
      ], true)
      storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = 'torn-dispatch' AND seq = 1")
      await expect(persistence.load(SessionId('torn-dispatch'))).rejects.toThrow('Cannot automatically repair')
      expect(queue.pending('torn-dispatch')).toHaveLength(1)
      const periodic = [1, 2].map(n => createEveryScheduleRecord(ScheduleId(`schedule-${n}`), `batch ${n}`, 300, now))
      await persistence.appendBatch(metadata('torn-batch'), periodic.map((schedule, seq) => ({ type: 'schedule/change', seq: SessionSeq(seq), time: now, data: { version: 1, operation: 'create', schedule } })), false)
      await persistence.appendBatch(metadata('torn-batch'), periodic.map((schedule, seq) => ({ type: 'schedule/change', seq: SessionSeq(seq + 2), time: now + 300_000, data: { version: 1, operation: 'dispatch', id: schedule.id, acceptedAt: new Date(now + 300_000).toISOString() } })), true)
      // The last dispatch shares the FIRST dispatch's input identity.
      storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = 'torn-batch' AND seq = 3")
      await expect(persistence.load(SessionId('torn-batch'))).rejects.toThrow('Cannot automatically repair')
      expect(queue.pending('torn-batch')).toHaveLength(1)

    } finally { await fiber.dispose(); storage.close() }
  })

  it('isolates durable reminder retry deadlines across sessions and prunes them on deletion', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    new MainSessionQueue(storage as never)
    const now = Date.now()
    const metadata = (id: string) => ({ meta: { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }, inheritedEventCount: SessionLogOffset(0) })
    try {
      for (const [id, age] of [['broken', 5000], ['healthy', 4000], ['other-broken', 3000]] as const) {
        const schedule = createAfterScheduleRecord(ScheduleId('schedule-1'), id, 1, now - age)
        await persistence.appendBatch(metadata(id), [{ type: 'schedule/change', seq: SessionSeq(0), time: now, data: { version: 1, operation: 'create', schedule } }], false)
      }
      expect(nextSchedule(storage as never)?.sessionId).toBe('broken')
      setScheduleRetry(storage as never, 'broken', now + 30_000)
      setScheduleRetry(storage as never, 'other-broken', now + 60_000)
      expect(nextSchedule(storage as never)?.sessionId).toBe('healthy')
      // Reinitializing host schemas must not lose the deadlines on a cold start.
      initializeSchedules(storage as never)
      new MainSessionQueue(storage as never)
      expect(nextSchedule(storage as never)?.sessionId).toBe('healthy')
      await persistence.appendBatch(metadata('healthy'), [{ type: 'schedule/change', seq: SessionSeq(1), time: now, data: { version: 1, operation: 'dispatch', id: ScheduleId('schedule-1') } }], true)
      expect(nextSchedule(storage as never)).toEqual({ sessionId: 'broken', due: now + 30_000 })
      setScheduleRetry(storage as never, 'broken', now + 90_000)
      expect(nextSchedule(storage as never)).toEqual({ sessionId: 'other-broken', due: now + 60_000 })
      setScheduleRetry(storage as never, 'other-broken', 0)
      expect(nextSchedule(storage as never)?.due).toBeLessThan(now)
      await persistence.appendBatch(metadata('broken'), [{ type: 'schedule/change', seq: SessionSeq(1), time: now, data: { version: 1, operation: 'delete', id: ScheduleId('schedule-1') } }], true)
      setScheduleRetry(storage as never, 'missing-session', now + 30_000)
      expect(storage.sql.exec('SELECT * FROM dsh_schedule_retry').toArray()).toEqual([])
    } finally { await fiber.dispose(); storage.close() }
  })

  it('backs off an overdue reminder blocked by crash-paused byte capacity', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const queue = new MainSessionQueue(storage as never)
    const id = SessionId('blocked-reminder')
    const now = Date.now()
    const record = createAfterScheduleRecord(ScheduleId('schedule-1'), 'blocked reminder', 1, now - 2000)
    try {
      await persistence.appendBatch({ meta: { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }, inheritedEventCount: SessionLogOffset(0) }, [
        { type: 'schedule/change', seq: SessionSeq(0), time: now, data: { version: 1, operation: 'create', schedule: record } },
      ], false)
      const message = createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024 - 700) }], source: { kind: 'user' } })
      queue.enqueue('paused-session', message.id, 'paused', message)
      storage.sql.exec('UPDATE dsh_runtime_ready SET paused = 1')
      expect(reserveScheduleAdmission(storage as never, id, dueScheduleChanges(storage as never, id, now))).toBe(false)
      expect(queue.claim()).toBeUndefined()
      setScheduleRetry(storage as never, id, now + 30_000)
      expect(scheduleWakeTime(nextSchedule(storage as never)?.due, false, now)).toBe(now + 30_000)
      expect(scheduleWakeTime(nextSchedule(storage as never)?.due, false, now + 100)).toBe(now + 30_000)
    } finally { await fiber.dispose(); storage.close() }
  })

  it('commits schedule, alarm, dispatch and reminder admission atomically across restarts', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const queue = new MainSessionQueue(storage as never)
    const id = SessionId('schedule-atomic')
    const meta: SessionHeader = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
    const record = createAfterScheduleRecord(ScheduleId('schedule-1'), 'remind me', 1, Date.now())
    const event: SessionEvent<'schedule/change'> = { type: 'schedule/change', seq: SessionSeq(0), time: Date.now(), data: { version: 1, operation: 'create', schedule: record } }
    const dispatch: SessionEvent<'schedule/change'> = { ...event, seq: SessionSeq(1), data: { version: 1, operation: 'dispatch', id: record.id } }
    const metadata = { meta, inheritedEventCount: SessionLogOffset(0) }
    try {
      storage.failAlarm = true
      await expect(persistence.appendBatch(metadata, [event], false)).rejects.toThrow('alarm failure')
      expect(nextSchedule(storage as never)).toBeUndefined()
      storage.failAlarm = false
      await persistence.appendBatch(metadata, [event], false)
      expect(nextSchedule(storage as never)?.due).toBe(Date.parse(record.scheduledAt))
      expect(storage.alarm).toBe(Date.parse(record.scheduledAt))
      storage.failNextEventInsert()
      await expect(persistence.appendBatch(metadata, [dispatch], true)).rejects.toThrow('injected')
      expect(queue.pending(id)).toHaveLength(0)
      expect(nextSchedule(storage as never)).toBeDefined()
      expect(reserveScheduleAdmission(storage as never, id, [dispatch.data])).toBe(true)
      // Another tab cannot consume bytes reserved for the pending reminder flush.
      const empty = createUserMessage({ content: [{ type: 'text', text: '' }], source: { kind: 'user' } })
      const large = { ...empty, content: [{ type: 'text' as const, text: 'x'.repeat(2 * 1024 * 1024 - new TextEncoder().encode(JSON.stringify(empty)).byteLength - 1) }] }
      expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeLessThan(2 * 1024 * 1024)
      expect(() => queue.enqueue('other-session', large.id, 'large', large)).toThrow('queue is full')
      const small = createUserMessage({ content: [{ type: 'text', text: 'small' }], source: { kind: 'user' } })
      queue.enqueue('other-session', small.id, 'small', small)
      expect(() => queue.edit('other-session', small.id, { ...large, id: small.id })).toThrow('byte limit')
      queue.remove('other-session', small.id)

      await persistence.appendBatch(metadata, [dispatch], true)
      expect(storage.sql.exec('SELECT * FROM dsh_runtime_schedule_reservation').toArray()).toHaveLength(0)
      expect(nextSchedule(storage as never)).toBeUndefined()
      const restored = new MainSessionQueue(storage as never)
      expect(restored.pending(id)).toHaveLength(1)
      expect(restored.pending(id)[0]!.message.source).toEqual({ kind: 'plugin', plugin: 'schedule' })
      await expect(persistence.appendBatch(metadata, [dispatch], true)).rejects.toThrow()
      expect(restored.pending(id)).toHaveLength(1)
    } finally { await fiber.dispose(); storage.close() }
  })

  it('batches missed periodic reminders once and excludes inherited schedules', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const queue = new MainSessionQueue(storage as never)
    const id = SessionId('schedule-every')
    const meta: SessionHeader = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
    const now = Date.now()
    const records = [1, 2].map(n => createEveryScheduleRecord(ScheduleId(`schedule-${n}`), `reminder ${n}`, 300, now))
    const events = records.map((schedule, seq): SessionEvent<'schedule/change'> => ({ type: 'schedule/change', seq: SessionSeq(seq), time: now, data: { version: 1, operation: 'create', schedule } }))
    const metadata = { meta, inheritedEventCount: SessionLogOffset(0) }
    try {
      await persistence.appendBatch(metadata, events, false)
      const changes = dueScheduleChanges(storage as never, id, now + 950_000)
      expect(changes).toHaveLength(2)
      await persistence.appendBatch(metadata, changes.map((data, n) => ({ type: 'schedule/change', seq: SessionSeq(n + 2), time: now + 950_000, data })), true)
      expect(queue.pending(id)).toHaveLength(1)
      expect(nextSchedule(storage as never)?.due).toBe(now + 1_200_000)
      expect(JSON.stringify(queue.pending(id)[0]!.message)).toContain('SCHEDULE REMINDER BATCH')
      storage.sql.exec('UPDATE dsh_runtime_ready SET paused = 1 WHERE session_id = ?', id)
      expect(nextSchedule(storage as never)).toBeUndefined()
      const recovery = createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } })
      queue.enqueue(id, recovery.id, 'recovery', recovery)
      expect(nextSchedule(storage as never)?.sessionId).toBe(id)
      await persistence.appendBatch(metadata, records.map((record, n) => ({ type: 'schedule/change', seq: SessionSeq(n + 4), time: now + 950_000, data: { version: 1, operation: 'delete', id: record.id } })), true)
      expect(nextSchedule(storage as never)).toBeUndefined()

      const child = { ...meta, id: SessionId('schedule-child'), isSeeded: true as const, parentSession: id }
      await persistence.appendBatch({ meta: child, inheritedEventCount: SessionLogOffset(2) }, events, false)
      expect(dueScheduleChanges(storage as never, child.id, now + 950_000)).toHaveLength(0)
    } finally { await fiber.dispose(); storage.close() }
  })

  it('commits the admission receipt atomically with the canonical inbox append', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const queue = new MainSessionQueue(storage as never)
    const id = SessionId('atomic-main-admission')
    const message = createUserMessage({ content: [{ type: 'text', text: 'only once' }], source: { kind: 'user' } })
    const input = queue.enqueue(id, message.id, 'digest', message)
    queue.claim()
    const meta: SessionHeader = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
    const event: SessionEvent<'agent/inbox/spliced'> = {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [message] },
    }
    try {
      storage.failNextEventInsert()
      await expect(persistence.appendBatch({ meta, inheritedEventCount: SessionLogOffset(0) }, [event], false)).rejects.toThrow('injected')
      expect(queue.state(input.seq)).toBe('claimed')
      await persistence.appendBatch({ meta, inheritedEventCount: SessionLogOffset(0) }, [event], false)
      expect(queue.state(input.seq)).toBe('admitted')
      expect((await persistence.load(id)).events).toHaveLength(1)
    } finally { await fiber.dispose(); storage.close() }
  })

  it('projects the latest upstream request/header model selection with a point read', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('model-selection-projection')
    try {
      await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
      await persistence.append(id, [{
        type: 'request/header',
        seq: SessionSeq(0),
        time: 2,
        data: {
          header: {
            config: {
              provider: 'deepseek-official',
              model: 'deepseek-v4-flash-vision-exp',
              reasoningEffort: ReasoningEffortId('high'),
            },
          },
          reason: 'initial',
        },
      }])

      expect(persistence.readLatestModelSelection(id)).toEqual({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash-vision-exp',
        reasoningEffort: 'high',
      })
      expect(storage.queries.at(-1)).toMatch(/type = 'request\/header'.*ORDER BY seq DESC LIMIT 1/su)
    } finally {
      await fiber.dispose()
      storage.close()
    }
  })

  it('persists and restores the fork-inherited event count across cold loads', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('forked-inherited-count')
    try {
      await persistence.create(
        { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: true },
        SessionLogOffset(6),
      )
      const seed: SessionEvent[] = []
      for (let turn = 1; turn <= 3; turn += 1) {
        seed.push(
          { type: 'turn/start', seq: SessionSeq(seed.length), time: 2, data: { turn } },
          {
            type: 'turn/end',
            seq: SessionSeq(seed.length + 1),
            time: 3,
            data: { turn, reason: { kind: 'completed' } },
          },
        )
      }
      await persistence.append(id, seed)

      const prefix = await persistence.loadStored(id)
      expect(prefix?.inheritedEventCount).toBe(6)
      expect(prefix?.meta.isSeeded).toBe(true)
      const suffix = await persistence.loadStoredFrom(id, SessionLogOffset(0))
      expect(suffix?.inheritedEventCount).toBe(6)
    } finally {
      await fiber.dispose()
      storage.close()
    }
  })

  it('resumes and extends the released 0.1.3 session state', async () => {
    const storage = new TestDurableObjectStorage()
    storage.loadFixture(readFileSync(
      new URL('./fixtures/dsh-edge-0.1.3-session.sql', import.meta.url),
      'utf8',
    ))
    const id = SessionId('session-v0-1-3')
    const blankId = SessionId('session-v0-1-3-blank')
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
        storage: storage as never,
      })
      const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
      try {
        expect(persistence.readSessionSummary(id)).toMatchObject({
          meta: {
            id,
            version: SESSION_FORMAT_VERSION,
            cwd: '/workspace',
            agentPreset: 'dsh-edge',
          },
          titleEvent: {
            type: 'session/title',
            data: { title: 'DSH Edge 0.1.3 fixture' },
          },
          lastSeq: 6,
        })
        const loaded = await persistence.load(id)
        expect(loaded.events).toMatchObject([
          { seq: SessionSeq(0), type: 'session/title' },
          { seq: SessionSeq(1), type: 'turn/start' },
          { seq: SessionSeq(2), type: 'user/message' },
          { seq: SessionSeq(3), type: 'step/start' },
          { seq: SessionSeq(4), type: 'assistant/message' },
          { seq: SessionSeq(5), type: 'step/end' },
          { seq: SessionSeq(6), type: 'turn/end' },
        ])
        expect(persistence.readBlankSession(blankId)).toMatchObject({
          version: SESSION_FORMAT_VERSION,
          cwd: '/workspace',
          agentPreset: 'dsh-edge',
        })

        let resumed!: Session
        const resumedFiber = await ctx.plugin(Object.assign((inner: Context) => {
          resumed = inner.sessions.create(id, { seed: loaded.events, meta: loaded.meta })
        }, { inject: ['sessions'] }))
        try {
          resumed.append('turn/start', { turn: 2 })
          resumed.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
          await ctx.sessions.flush(resumed)
        } finally {
          await resumedFiber.dispose()
        }

        await expect(persistence.materializeBlankSession(blankId)).resolves.toBe(true)
        const loadedBlank = await persistence.load(blankId)
        let promoted!: Session
        const promotedFiber = await ctx.plugin(Object.assign((inner: Context) => {
          promoted = inner.sessions.create(blankId, {
            meta: loadedBlank.meta,
          })
        }, { inject: ['sessions'] }))
        try {
          promoted.append('session/title', {
            title: 'Promoted 0.1.3 blank session',
            messageSeqs: [],
            source: { kind: 'user' },
          })
          await ctx.sessions.flush(promoted)
        } finally {
          await promotedFiber.dispose()
        }
      } finally {
        await fiber.dispose()
        await ctx.fiber.dispose()
      }

      const reloadedCtx = new Context()
      await reloadedCtx.plugin(SessionStore)
      const reloadedFiber = await reloadedCtx.plugin(DurableObjectSessionPersistence, {
        storage: storage as never,
      })
      try {
        await expect(reloadedCtx.sessionPersistence.load(id)).resolves.toMatchObject({
          events: [
            { seq: SessionSeq(0), type: 'session/title' },
            { seq: SessionSeq(1), type: 'turn/start' },
            { seq: SessionSeq(2), type: 'user/message' },
            { seq: SessionSeq(3), type: 'step/start' },
            { seq: SessionSeq(4), type: 'assistant/message' },
            { seq: SessionSeq(5), type: 'step/end' },
            { seq: SessionSeq(6), type: 'turn/end' },
            { seq: SessionSeq(7), type: 'session/end-seed' },
            { seq: 8, type: 'turn/start' },
            { seq: 9, type: 'turn/end' },
          ],
        })
        await expect(reloadedCtx.sessionPersistence.load(blankId)).resolves.toMatchObject({
          events: [{ seq: SessionSeq(0), type: 'session/title' }],
        })
      } finally {
        await reloadedFiber.dispose()
        await reloadedCtx.fiber.dispose()
      }
    } finally {
      storage.close()
    }
  })

  it('round-trips an interrupted assistant prefix through cold storage', async () => {
    const storage = new TestDurableObjectStorage()
    const id = SessionId('interrupted-assistant-prefix')
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'A visible prefix before cancellation.' }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    try {
      await ctx.sessionPersistence.create({
        id,
        version: SESSION_FORMAT_VERSION,
        createdAt: 1,
        isSeeded: false,
      })
      await ctx.sessionPersistence.append(id, [
        { type: 'turn/start', seq: SessionSeq(0), time: 2, data: { turn: 1 } },
        { type: 'step/start', seq: SessionSeq(1), time: 3, data: { turn: 1, step: 1 } },
        {
          type: 'assistant/message',
          seq: SessionSeq(2),
          time: 4,
          data: { turn: 1, step: 1, message, interrupted: true },
          sourceEventSeqs: [],
          surfaceOp: 'append',
        },
        { type: 'step/end', seq: SessionSeq(3), time: 5, data: { turn: 1, step: 1 } },
        {
          type: 'turn/end',
          seq: SessionSeq(4),
          time: 6,
          data: { turn: 1, reason: { kind: 'interrupted' } },
        },
      ])
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }

    const coldCtx = new Context()
    await coldCtx.plugin(SessionStore)
    const coldFiber = await coldCtx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = coldCtx.sessionPersistence as unknown as DurableObjectSessionPersistence
    try {
      await expect(persistence.load(id)).resolves.toMatchObject({
        events: [{ seq: 0 }, { seq: 1 }, {
          type: 'assistant/message',
          seq: SessionSeq(2),
          data: {
            message: { content: [{ type: 'text', text: 'A visible prefix before cancellation.' }] },
            interrupted: true,
          },
        }, { seq: 3 }, { seq: 4 }],
      })
      await expect(persistence.readEventPage(id, 2, 1, 8_192)).resolves.toMatchObject({
        events: [{
          type: 'assistant/message',
          seq: SessionSeq(2),
          data: { interrupted: true },
        }],
        hasMore: true,
      })
    } finally {
      await coldFiber.dispose()
      await coldCtx.fiber.dispose()
      storage.close()
    }
  })

  it('selects a cold history tail before loading event payloads', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistenceFiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('bounded-cold-history')
    let session!: Session
    const ownerFiber = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(id)
    }, { inject: ['sessions'] }))
    try {
      for (let index = 0; index < 60; index++) {
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `prompt ${String(index)}` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
      }
      await ctx.sessions.flush(session)
      await ownerFiber.dispose()

      const payloadReadsBefore = storage.queries.filter(isEventPayloadQuery).length
      await expect(persistence.readHistoryPage(id, undefined, 2)).resolves.toMatchObject({
        events: [
          { type: 'user/message', seq: 58 },
          { type: 'user/message', seq: 59 },
        ],
        hasMore: true,
        summary: { meta: { id }, lastSeq: 59 },
      })
      expect(storage.queries.filter(isEventPayloadQuery).length).toBeGreaterThan(payloadReadsBefore)
    } finally {
      await ownerFiber.dispose()
      await persistenceFiber.dispose()
      await ctx.fiber.dispose()
      storage.close()
    }
  })

  it('caps an oversized cold history request before materializing boundary rows', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistenceFiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('bounded-cold-history-limit')
    let session!: Session
    const ownerFiber = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(id)
    }, { inject: ['sessions'] }))
    try {
      for (let index = 0; index < 60; index++) {
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `prompt ${String(index)}` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
      }
      await ctx.sessions.flush(session)
      await ownerFiber.dispose()

      await expect(persistence.readHistoryPage(id, undefined, Number.MAX_SAFE_INTEGER))
        .resolves.toMatchObject({
          events: [
            { type: 'user/message', seq: 10 },
            ...Array.from({ length: 49 }, (_, index) => ({
              type: 'user/message',
              seq: index + 11,
            })),
          ],
          hasMore: true,
        })
    } finally {
      await ownerFiber.dispose()
      await persistenceFiber.dispose()
      await ctx.fiber.dispose()
      storage.close()
    }
  })

  it('retains blank identities and promotes them into canonical empty logs', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('retained-blank')
    const header: SessionHeader = {
      id,
      version: SESSION_FORMAT_VERSION,
      createdAt: 17,
      isSeeded: false,
      cwd: '/workspace',
      agentPreset: 'dsh-edge',
    }
    try {
      await persistence.retainBlankSession(header)
      expect(persistence.hasSession(id)).toBe(false)
      expect(persistence.readBlankSession(id)).toEqual(header)
      expect(persistence.readAllBlankSessions()).toEqual([header])

      // Exercise the same cold prepare used by model selection/upstream follow.
      const prepared = await persistence.prepare(id)
      const detach = ctx.sessions.enter(prepared.session)
      ctx.sessions.announce(prepared.session)
      prepared.session.append('model/selection', { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
      await ctx.sessions.flush(prepared.session)
      detach()
      prepared[Symbol.dispose]()
      expect(persistence.readBlankSession(id)).toBeUndefined()
      expect(persistence.hasSession(id)).toBe(true)
      await expect(persistence.inspect(id)).resolves.toMatchObject({
        meta: header,
        events: [expect.objectContaining({ type: 'session/end-seed' }), expect.objectContaining({ type: 'model/selection' })],
      })
    } finally {
      await fiber.dispose()
      storage.close()
    }
  })

  it('abandons a failed first materialization before disposal can retry it', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistenceFiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('abandoned-creation')
    let session!: Session
    const ownerFiber = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(id)
    }, { inject: ['sessions'] }))
    try {
      session.append('session/title', {
        title: 'Never materialized',
        messageSeqs: [],
        source: { kind: 'user' },
      })
      storage.failNextEventInsert()
      await expect(ctx.sessions.flush(session)).rejects.toThrow('injected event insert failure')

      await persistence.abandonUnmaterializedSession(session)
      await ownerFiber.dispose()
      await persistenceFiber.dispose()

      expect(storage.sql.exec('SELECT id FROM dsh_sessions').toArray()).toEqual([])
    } finally {
      await ownerFiber.dispose()
      await persistenceFiber.dispose()
      await ctx.fiber.dispose()
      storage.close()
    }
  })

  it('uses point queries for session existence and detail summaries', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('point-summary')
    try {
      await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
      await persistence.append(id, [{
        type: 'session/title',
        seq: SessionSeq(0),
        time: 2,
        data: {
          title: 'Point summary',
          messageSeqs: [],
          source: { kind: 'user' },
        },
      }])

      const queryStart = storage.queries.length
      expect(persistence.hasSession(id)).toBe(true)
      expect(persistence.readSessionHeader(id)).toMatchObject({ id })
      expect(persistence.readSessionSummary(id)).toMatchObject({
        meta: { id },
        titleEvent: { seq: SessionSeq(0), type: 'session/title' },
        updatedAt: 2,
      })
      const queries = storage.queries.slice(queryStart)
      expect(queries).toHaveLength(3)
      expect(queries[0]).toMatch(/FROM dsh_sessions WHERE id = \?/u)
      expect(queries[1]).toMatch(/FROM dsh_sessions WHERE id = \?/u)
      expect(queries[2]).toMatch(/FROM dsh_sessions s\b/u)
    } finally {
      await fiber.dispose()
      storage.close()
    }
  })

  it('refuses unsupported formats in point and list summaries before decoding titles', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('future-summary')
    try {
      await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
      await persistence.append(id, [{
        type: 'session/title',
        seq: SessionSeq(0),
        time: 2,
        data: {
          title: 'Current title',
          messageSeqs: [],
          source: { kind: 'user' },
        },
      }])
      storage.sql.exec('UPDATE dsh_sessions SET version = ? WHERE id = ?', 99, id)
      storage.sql.exec(
        "UPDATE dsh_session_events SET data = '{future-title-format' WHERE session_id = ?",
        id,
      )

      expect(() => persistence.readSessionSummary(id))
        .toThrow(/uses log format v99/u)
      expect(() => persistence.readSessionHeader(id))
        .toThrow(/uses log format v99/u)
      expect(() => persistence.readSessionSummaryPage(undefined, 1))
        .toThrow(/uses log format v99/u)
    } finally {
      await fiber.dispose()
      storage.close()
    }
  })

  it('rejects malformed current-format title payloads in point and list summaries', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('malformed-title-summary')
    try {
      await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
      await persistence.append(id, [{
        type: 'session/title',
        seq: SessionSeq(0),
        time: 2,
        data: {
          title: 'Current title',
          messageSeqs: [],
          source: { kind: 'user' },
        },
      }])
      const malformedPayloads = [
        { title: 123, messageSeqs: [], source: { kind: 'user' } },
        { title: 'Title', messageSeqs: 'not-an-array', source: { kind: 'user' } },
        { title: 'Title', messageSeqs: [], source: { kind: 'unknown' } },
      ]
      for (const payload of malformedPayloads) {
        const raw = JSON.stringify(payload)
        storage.sql.exec(
          'UPDATE dsh_session_events SET data = ? WHERE session_id = ?',
          raw,
          id,
        )
        storage.sql.exec(
          'UPDATE dsh_session_summaries SET title_data = ? WHERE session_id = ?',
          raw,
          id,
        )
        expect(() => persistence.readSessionSummary(id))
          .toThrow(/invalid session\/title data/u)
        expect(() => persistence.readSessionSummaryPage(undefined, 1))
          .toThrow(/invalid session\/title data/u)
      }
    } finally {
      await fiber.dispose()
      storage.close()
    }
  })

  it('applies canonical format and event-vocabulary validation', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('bounded-validation')
    const header: SessionHeader = {
      id,
      version: SESSION_FORMAT_VERSION,
      createdAt: 1,
      isSeeded: false,
    }
    try {
      await ctx.sessionPersistence.create(header)
      await ctx.sessionPersistence.append(id, [{
        type: 'future/required-event',
        seq: SessionSeq(0),
        time: 2,
        data: null,
      } as unknown as SessionEvent])
      await expect(persistence.readEventPage(id, 0, 1, 1_024))
        .rejects.toThrow(/event type "future\/required-event".*not marked ignorable/u)

      storage.sql.exec('UPDATE dsh_sessions SET version = ? WHERE id = ?', 99, id)
      await expect(persistence.readEventPage(id, 0, 1, 1_024))
        .rejects.toThrow(/uses log format v99/u)
    } finally {
      await fiber.dispose()
      storage.close()
    }
  })

  it('keeps legacy prefix migration inside the bounded loader budget', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('bounded-legacy-prefix')
    try {
      await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
      await persistence.append(id, [
        {
          type: 'session/title',
          seq: SessionSeq(0),
          time: 2,
          data: {
            title: '界'.repeat(1_024),
            messageSeqs: [],
            source: { kind: 'user' },
          },
        },
        {
          type: 'user/message',
          seq: SessionSeq(1),
          time: 3,
          data: {
            content: [{ type: 'text', text: 'legacy prompt' }],
            source: { kind: 'user' },
          },
        } as unknown as SessionEvent,
      ])

      await expect(persistence.readEventPage(id, 1, 1, 512))
        .rejects.toThrow(/legacy replay prefix exceeds the bounded page capacity/u)

      await expect(persistence.readEventPage(id, 1, 1, 8_192)).resolves.toMatchObject({
        events: [{
          type: 'user/message',
          seq: SessionSeq(1),
          data: { id: `legacy-message:${id}:1` },
        }],
        hasMore: false,
      })
    } finally {
      await fiber.dispose()
      storage.close()
    }
  })

  it('stops before loading an event whose stored payload exceeds the byte budget', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('bounded-payload')
    const header: SessionHeader = {
      id,
      version: SESSION_FORMAT_VERSION,
      createdAt: 1,
      isSeeded: false,
    }
    try {
      await persistence.create(header)
      await persistence.append(id, [{
        type: 'session/title',
        seq: SessionSeq(0),
        time: 2,
        data: {
          title: '界'.repeat(1_024),
          messageSeqs: [],
          source: { kind: 'user' },
        },
      }])

      await expect(persistence.readEventPage(id, 0, 1, 128)).resolves.toMatchObject({
        events: [],
        hasMore: true,
      })
      await expect(persistence.readEventPage(id, 0, 1, 8_192)).resolves.toMatchObject({
        events: [{ seq: SessionSeq(0), type: 'session/title' }],
        hasMore: false,
      })
    } finally {
      await fiber.dispose()
      storage.close()
    }
  })
})

function isEventPayloadQuery(query: string): boolean {
  return /SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable/u.test(query)
}
