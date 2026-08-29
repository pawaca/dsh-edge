/// <reference types="node" />

import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import DurableObjectSessionPersistence from '../src/do-session-persistence.ts'

/** Minimal Node-backed implementation of the DO synchronous SQL surface. */
class TestDurableObjectStorage {
  private readonly db = new DatabaseSync(':memory:')
  private eventInsertFailures = 0
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
  it('projects the latest upstream request/header model selection with a point read', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('model-selection-projection')
    try {
      await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1 })
      await persistence.append(id, [{
        type: 'request/header',
        seq: 0,
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
      const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
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
          { seq: 0, type: 'session/title' },
          { seq: 1, type: 'turn/start' },
          { seq: 2, type: 'user/message' },
          { seq: 3, type: 'step/start' },
          { seq: 4, type: 'assistant/message' },
          { seq: 5, type: 'step/end' },
          { seq: 6, type: 'turn/end' },
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
            { seq: 0, type: 'session/title' },
            { seq: 1, type: 'turn/start' },
            { seq: 2, type: 'user/message' },
            { seq: 3, type: 'step/start' },
            { seq: 4, type: 'assistant/message' },
            { seq: 5, type: 'step/end' },
            { seq: 6, type: 'turn/end' },
            { seq: 7, type: 'session/end-seed' },
            { seq: 8, type: 'turn/start' },
            { seq: 9, type: 'turn/end' },
          ],
        })
        await expect(reloadedCtx.sessionPersistence.load(blankId)).resolves.toMatchObject({
          events: [{ seq: 0, type: 'session/title' }],
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
      })
      await ctx.sessionPersistence.append(id, [
        { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: 3, data: { turn: 1, step: 1 } },
        {
          type: 'assistant/message',
          seq: 2,
          time: 4,
          data: { turn: 1, step: 1, message, interrupted: true },
          sourceEventSeqs: [],
          surfaceOp: 'append',
        },
        { type: 'step/end', seq: 3, time: 5, data: { turn: 1, step: 1 } },
        {
          type: 'turn/end',
          seq: 4,
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
    const persistence = coldCtx.sessionPersistence as DurableObjectSessionPersistence
    try {
      await expect(persistence.load(id)).resolves.toMatchObject({
        events: [{ seq: 0 }, { seq: 1 }, {
          type: 'assistant/message',
          seq: 2,
          data: {
            message: { content: [{ type: 'text', text: 'A visible prefix before cancellation.' }] },
            interrupted: true,
          },
        }, { seq: 3 }, { seq: 4 }],
      })
      await expect(persistence.readEventPage(id, 2, 1, 8_192)).resolves.toMatchObject({
        events: [{
          type: 'assistant/message',
          seq: 2,
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
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
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
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
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
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('retained-blank')
    const header: SessionHeader = {
      id,
      version: SESSION_FORMAT_VERSION,
      createdAt: 17,
      cwd: '/workspace',
      agentPreset: 'dsh-edge',
    }
    try {
      await persistence.retainBlankSession(header)
      expect(persistence.hasSession(id)).toBe(false)
      expect(persistence.readBlankSession(id)).toEqual(header)
      expect(persistence.readAllBlankSessions()).toEqual([header])

      await expect(persistence.materializeBlankSession(id)).resolves.toBe(true)
      expect(persistence.readBlankSession(id)).toBeUndefined()
      expect(persistence.hasSession(id)).toBe(true)
      await expect(persistence.inspect(id)).resolves.toMatchObject({
        meta: header,
        events: [],
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
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
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
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('point-summary')
    try {
      await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1 })
      await persistence.append(id, [{
        type: 'session/title',
        seq: 0,
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
        titleEvent: { seq: 0, type: 'session/title' },
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
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('future-summary')
    try {
      await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1 })
      await persistence.append(id, [{
        type: 'session/title',
        seq: 0,
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
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('malformed-title-summary')
    try {
      await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1 })
      await persistence.append(id, [{
        type: 'session/title',
        seq: 0,
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
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('bounded-validation')
    const header: SessionHeader = {
      id,
      version: SESSION_FORMAT_VERSION,
      createdAt: 1,
    }
    try {
      await ctx.sessionPersistence.create(header)
      await ctx.sessionPersistence.append(id, [{
        type: 'future/required-event',
        seq: 0,
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
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('bounded-legacy-prefix')
    try {
      await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1 })
      await persistence.append(id, [
        {
          type: 'session/title',
          seq: 0,
          time: 2,
          data: {
            title: '界'.repeat(1_024),
            messageSeqs: [],
            source: { kind: 'user' },
          },
        },
        {
          type: 'user/message',
          seq: 1,
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
          seq: 1,
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
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('bounded-payload')
    const header: SessionHeader = {
      id,
      version: SESSION_FORMAT_VERSION,
      createdAt: 1,
    }
    try {
      await persistence.create(header)
      await persistence.append(id, [{
        type: 'session/title',
        seq: 0,
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
        events: [{ seq: 0, type: 'session/title' }],
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
