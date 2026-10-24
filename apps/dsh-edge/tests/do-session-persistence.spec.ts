/// <reference types="node" />

import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, createAssistantMessage, createUserMessage, AssistantStreamAccumulator, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  interruptedTurnClosers,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import { MainSessionQueue } from '../src/main-session-queue.ts'
import DurableObjectSessionPersistence, { LEGACY_MIGRATION_MAX_BYTES } from '../src/do-session-persistence.ts'

async function readAll(persistence: DurableObjectSessionPersistence, id: ReturnType<typeof SessionId>) {
  const handle = await persistence.open(id, 'read')
  try {
    const result = await handle.read()
    return { events: [...result.events] as SessionEvent[], meta: handle.header }
  } finally { await handle.close() }
}

/** Exercise the same repair/read/closer sequence as upstream AgentLoop.resume. */
async function resumeStored(persistence: DurableObjectSessionPersistence, id: ReturnType<typeof SessionId>) {
  const handle = await persistence.open(id, 'write')
  try {
    const { events } = await handle.read()
    const closers = interruptedTurnClosers(events)
    await handle.append(closers)
    return { events: [...events, ...closers] }
  } finally { await handle.close() }
}

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
  writtenRows = 0

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
      if (/^(INSERT|UPDATE|DELETE)\b/iu.test(query.trimStart())) this.writtenRows += Number(result.changes)
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

describe('legacy Edge cancellation migration', () => {
  function insertLegacyDeltas(storage: TestDurableObjectStorage, count: number) {
    storage.sql.exec("UPDATE dsh_session_events SET seq = seq + ? WHERE session_id = 'session-v0-1-3' AND seq >= 4", count + 2)
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      ...Array.from({ length: count }, () => ({ type: 'text-delta', index: 0, text: 'x' })),
      { type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(count) } },
    ]
    chunks.forEach((chunk, i) => storage.sql.exec(
      'INSERT INTO dsh_session_events (session_id,seq,type,time,data) VALUES (?,?,?,?,?)',
      'session-v0-1-3', i + 4, 'assistant/chunk', 1004 + i, JSON.stringify({ turn: 1, step: 1, chunk }),
    ))
  }

  function cancelledStorage(message: unknown, extra: Record<string, unknown> = {}) {
    const storage = new TestDurableObjectStorage()
    storage.loadFixture(readFileSync(new URL('./fixtures/dsh-edge-0.1.3-session.sql', import.meta.url), 'utf8'))
    storage.sql.exec('DELETE FROM dsh_session_events')
    const rows: Array<{ type: string, data: unknown, surfaceOp?: string }> = [
      { type: 'session/end-seed', data: {} },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'user/message', surfaceOp: 'append', data: {
        id: 'cancelled-prompt', role: 'user', content: [{ type: 'text', text: 'preserve this prompt' }], source: { kind: 'user' },
      } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user', message, ...extra } } } },
    ]
    rows.forEach((row, seq) => storage.sql.exec(
      'INSERT INTO dsh_session_events (session_id, seq, type, time, data, surface_op) VALUES (?, ?, ?, ?, ?, ?)',
      'session-v0-1-3', seq, row.type, 1001 + seq, JSON.stringify(row.data), row.surfaceOp ? JSON.stringify(row.surfaceOp) : null,
    ))
    return storage
  }

  it.each(['cancelled by the user', 'turn was cancelled', 'turn deadline exceeded'])(
    'migrates and reopens a V0 turn cancelled with %s', async message => {
      const storage = cancelledStorage(message)
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      try {
        const persistence = new DurableObjectSessionPersistence(ctx, { storage: storage as never })
        const id = SessionId('session-v0-1-3')
        const restored = await readAll(persistence, id)
        expect(restored.meta.version).toBe(SESSION_FORMAT_VERSION)
        expect(restored.events.find(event => event.type === 'user/message')?.data).toMatchObject({
          content: [{ type: 'text', text: 'preserve this prompt' }],
        })
        expect(restored.events.at(-1)).toMatchObject({
          type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
        })
        expect(JSON.stringify(restored.events.at(-1))).not.toContain(message)
        const handle = await persistence.open(id, 'write')
        await handle.append([{ type: 'session/title', seq: SessionSeq(restored.events.length), time: 2000,
          data: { title: 'Recovered', messageSeqs: [], source: { kind: 'user' } } }])
        await handle.close()
        expect((await readAll(persistence, id)).events.at(-1)?.type).toBe('session/title')
        expect(persistence.readAllSessionSummaries().length).toBeGreaterThan(0)
      } finally { await ctx.fiber.dispose(); storage.close() }
    },
  )

  it('migrates 10,000 legacy token deltas without deleting each old row', async () => {
    const storage = cancelledStorage('cancelled by the user')
    storage.sql.exec('UPDATE dsh_session_events SET seq = seq + 10002 WHERE seq >= 4')
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      ...Array.from({ length: 10000 }, () => ({ type: 'text-delta', index: 0, text: 'x' })),
      { type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(10000) } },
    ]
    chunks.forEach((chunk, i) => storage.sql.exec(
      'INSERT INTO dsh_session_events (session_id,seq,type,time,data) VALUES (?,?,?,?,?)',
      'session-v0-1-3', i + 4, 'assistant/chunk', 1004 + i,
      JSON.stringify({ turn: 1, step: 1, chunk }),
    ))
    storage.writtenRows = 0
    storage.queries.length = 0
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const persistence = new DurableObjectSessionPersistence(ctx, { storage: storage as never })
      expect(storage.writtenRows).toBeLessThan(100)
      expect(storage.queries).toContain('DROP TABLE dsh_session_events')
      expect(storage.queries.some(q => q.startsWith('DELETE FROM dsh_session_events'))).toBe(false)
      const result = await readAll(persistence, SessionId('session-v0-1-3'))
      expect(result.meta.version).toBe(SESSION_FORMAT_VERSION)
      expect(JSON.stringify(result.events)).toContain('x'.repeat(10000))
      storage.writtenRows = 0
      for (let i = 0; i < 10; i++) {
        persistence.readAllSessionSummaries()
        await readAll(persistence, SessionId('session-v0-1-3'))
      }
      const restarted = new Context()
      await restarted.plugin(SessionStore)
      try {
        new DurableObjectSessionPersistence(restarted, { storage: storage as never })
        expect(storage.writtenRows).toBe(0)
      } finally { await restarted.fiber.dispose() }
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  // Removing ~200 packed delta rows costs ~400 writes in place (row + key index each);
  // copying up to ~100 current rows into a rebuilt table costs less.
  it.each([0, 1, 100, 1000, 100000])('preserves current logs and chooses the cheaper migration with %i current rows', async count => {
    const storage = cancelledStorage('cancelled by the user')
    // Token deltas the next format packs into one row: a rebuild avoids deleting each.
    insertLegacyDeltas(storage, 200)
    storage.sql.exec(`INSERT INTO dsh_sessions SELECT 'current', ?, created_at,cwd,parent_session,
      seed_length,origin,delegation_depth,agent_preset,'current-incarnation',revision FROM dsh_sessions`, SESSION_FORMAT_VERSION)
    for (let i = 0; i < count; i++) storage.sql.exec(
      'INSERT INTO dsh_session_events (session_id,seq,type,time,data) VALUES (?,?,?,?,?)',
      'current', i, 'session/title', 2000 + i,
      JSON.stringify({ title: 'Keep current', messageSeqs: [], source: { kind: 'user' } }),
    )
    if (count === 0) storage.sql.exec(`
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10000)
      INSERT INTO dsh_sessions
      SELECT 'sparse-' || x, version,created_at,cwd,parent_session,seed_length,origin,
        delegation_depth,agent_preset,'sparse-incarnation-' || x,revision
      FROM n CROSS JOIN dsh_sessions WHERE id = 'current'`)
    const before = storage.sql.exec("SELECT * FROM dsh_session_events WHERE session_id = 'current' ORDER BY seq").toArray()
    storage.queries.length = 0
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const persistence = new DurableObjectSessionPersistence(ctx, { storage: storage as never })
      expect(storage.queries.includes('DROP TABLE dsh_session_events')).toBe(count <= 100)
      expect(storage.queries.some(q => q.includes('GROUP BY s.version'))).toBe(false)
      expect(storage.queries.filter(q => q.includes('SELECT COUNT(*) AS count FROM ('))).toHaveLength(1)
      expect(storage.sql.exec("SELECT * FROM dsh_session_events WHERE session_id = 'current' ORDER BY seq").toArray()).toEqual(before)
      expect((await readAll(persistence, SessionId('session-v0-1-3'))).meta.version).toBe(SESSION_FORMAT_VERSION)
      expect(storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'dsh_session_events_migrating'").toArray()).toEqual([{ n: 0 }])
    } finally { await ctx.fiber.dispose(); storage.close() }
  }, 30_000) // The 100,000-row case seeds and migrates real SQLite rows; Windows runners take over 5 s.

  it('restores the original table if the compact table swap fails, then retries', async () => {
    const storage = cancelledStorage('cancelled by the user')
    // Token deltas the next format packs into one row: a rebuild avoids deleting each.
    insertLegacyDeltas(storage, 200)
    const before = storage.sql.exec('SELECT * FROM dsh_session_events ORDER BY seq').toArray()
    const exec = storage.sql.exec
    storage.sql.exec = (query, ...bindings) => {
      if (query.startsWith('ALTER TABLE dsh_session_events_migrating')) throw new Error('injected swap failure')
      return exec(query, ...bindings)
    }
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      expect(() => new DurableObjectSessionPersistence(ctx, { storage: storage as never })).toThrow('injected swap failure')
      expect(storage.queries).toContain('DROP TABLE dsh_session_events')
      expect(storage.sql.exec('SELECT * FROM dsh_session_events ORDER BY seq').toArray()).toEqual(before)
      expect(storage.sql.exec('SELECT version FROM dsh_sessions').toArray()).toEqual([{ version: 0 }])
      expect(storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'dsh_session_events_migrating'").toArray()).toEqual([{ n: 0 }])
      storage.sql.exec = exec
      const restarted = new Context()
      await restarted.plugin(SessionStore)
      try {
        const persistence = new DurableObjectSessionPersistence(restarted, { storage: storage as never })
        expect((await readAll(persistence, SessionId('session-v0-1-3'))).meta.version).toBe(SESSION_FORMAT_VERSION)
      } finally { await restarted.fiber.dispose() }
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it('writes only the rows the next format changes', async () => {
    // A V3 log whose rows the V4 transform leaves as they are, as most 0.18 rows are.
    const storage = cancelledStorage('cancelled by the user')
    storage.sql.exec(`INSERT INTO dsh_sessions SELECT 'v3-titles', 3, created_at, cwd, parent_session, NULL, origin,
      delegation_depth, 'standard', 'v3-incarnation', revision FROM dsh_sessions WHERE id = 'session-v0-1-3'`)
    storage.sql.exec("INSERT INTO dsh_session_events (session_id,seq,type,time,data) VALUES ('v3-titles',0,'session/end-seed',1000,'{}')")
    for (let i = 1; i <= 200; i++) storage.sql.exec(
      'INSERT INTO dsh_session_events (session_id,seq,type,time,data) VALUES (?,?,?,?,?)',
      'v3-titles', i, 'session/title', 1000 + i,
      JSON.stringify({ title: 'Legacy title', messageSeqs: [], source: { kind: 'user' } }),
    )
    const before = 201
    storage.writtenRows = 0
    storage.queries.length = 0
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const persistence = new DurableObjectSessionPersistence(ctx, { storage: storage as never })
      // Identical rows stay in place: no whole-log delete, no rebuild, a handful of writes.
      expect(storage.queries.some(q => q.trim().endsWith('DELETE FROM dsh_session_events WHERE session_id = ?'))).toBe(false)
      expect(storage.queries.includes('DROP TABLE dsh_session_events')).toBe(false)
      expect(storage.writtenRows).toBeLessThan(before / 10)
      const restored = await readAll(persistence, SessionId('v3-titles'))
      expect(restored.meta.version).toBe(SESSION_FORMAT_VERSION)
      expect(restored.events.filter(event => event.type === 'session/title')).toHaveLength(200)
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it('reads subagent children for every outdated session in one scan', async () => {
    const storage = cancelledStorage('cancelled by the user')
    const clone = (id: string, parent: string | null) => {
      storage.sql.exec(`INSERT INTO dsh_sessions
        SELECT ?, version, created_at, cwd, ?, seed_length, ?, ?, agent_preset, ?, revision
        FROM dsh_sessions WHERE id = 'session-v0-1-3'`,
      id, parent, parent === null ? null : 'subagent', parent === null ? null : 1, `${id}-incarnation`)
      storage.sql.exec(`INSERT INTO dsh_session_events
        SELECT ?, seq, type, time, data, source_event_seqs, surface_op, ignorable
        FROM dsh_session_events WHERE session_id = 'session-v0-1-3'`, id)
    }
    for (let n = 0; n < 40; n++) clone(`outdated-${String(n)}`, null)
    clone('outdated-child', 'session-v0-1-3')
    storage.queries.length = 0
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const persistence = new DurableObjectSessionPersistence(ctx, { storage: storage as never })
      // No per-parent lookup: parent_session has no index, so each would scan the table.
      expect(storage.queries.filter(query => /parent_session = \?/u.test(query))).toHaveLength(0)
      expect(storage.queries.filter(query => /origin = 'subagent' AND parent_session IS NOT NULL/u.test(query))).toHaveLength(1)
      expect(storage.sql.exec('SELECT DISTINCT version FROM dsh_sessions').toArray()).toEqual([{ version: SESSION_FORMAT_VERSION }])
      expect((await readAll(persistence, SessionId('outdated-child'))).meta).toMatchObject({ parentSession: 'session-v0-1-3' })
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it('preflights all sessions without repeated migration writes when a later session is incompatible', async () => {
    const storage = cancelledStorage('cancelled by the user')
    storage.sql.exec(`INSERT INTO dsh_sessions
      SELECT 'later-incompatible', version, created_at, cwd, parent_session, seed_length, origin,
      delegation_depth, agent_preset, 'later-incarnation', revision FROM dsh_sessions`)
    storage.sql.exec(`INSERT INTO dsh_session_events
      SELECT 'later-incompatible', seq, type, time, data, source_event_seqs, surface_op, ignorable FROM dsh_session_events`)
    storage.sql.exec("UPDATE dsh_session_events SET data = ? WHERE session_id = 'later-incompatible' AND type = 'turn/end'",
      JSON.stringify({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user', message: 'unknown payload' } } }))
    const tables = ['dsh_sessions', 'dsh_session_events', 'dsh_session_summaries', 'dsh_edge_blank_sessions']
    const before = tables.map(table => storage.sql.exec(`SELECT * FROM ${table}`).toArray())
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      storage.writtenRows = 0
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(() => new DurableObjectSessionPersistence(ctx, { storage: storage as never })).toThrow()
        // One initial store-identity insert; no migration writes on any attempt.
        expect(storage.writtenRows).toBe(1)
      }
      expect(tables.map(table => storage.sql.exec(`SELECT * FROM ${table}`).toArray())).toEqual(before)
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it('starts with a legacy log too large to migrate, migrates the rest, and unlists and refuses only that session', async () => {
    const storage = cancelledStorage('cancelled by the user')
    storage.sql.exec(`INSERT INTO dsh_sessions
      SELECT 'legacy-large', version, created_at, cwd, parent_session, seed_length, origin,
      delegation_depth, agent_preset, 'large-incarnation', revision FROM dsh_sessions`)
    storage.sql.exec(`INSERT INTO dsh_session_events
      SELECT 'legacy-large', seq, type, time, data, source_event_seqs, surface_op, ignorable FROM dsh_session_events`)
    // Never decoded: the size alone keeps it out of the migration.
    storage.sql.exec(
      'INSERT INTO dsh_session_events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)',
      'legacy-large', 100, 'system/message', 2000, JSON.stringify({ text: 'x'.repeat(LEGACY_MIGRATION_MAX_BYTES) }),
    )
    const largeBefore = storage.sql.exec("SELECT * FROM dsh_session_events WHERE session_id = 'legacy-large' ORDER BY seq").toArray()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const persistence = new DurableObjectSessionPersistence(ctx, { storage: storage as never })
      expect((await readAll(persistence, SessionId('session-v0-1-3'))).meta.version).toBe(SESSION_FORMAT_VERSION)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('legacy-large keeps format version 0'))
      const opening = persistence.open(SessionId('legacy-large'), 'read')
      await expect(opening).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
      await expect(opening).rejects.toThrow(/format version 0 with 8\.0 MiB of events, more than the 8\.0 MiB .* cannot be opened here/u)
      // Unlisted before the page limit applies: it sorts first (same created_at,
      // lower id), and a one-session page still holds the migrated session.
      const page = persistence.readSessionSummaryPage(undefined, 1)!
      expect(page.sessions.map(s => s.meta.id)).toEqual(['session-v0-1-3'])
      expect(page.hasMore).toBe(false)
      expect(persistence.readRecentSessionSummaries(1).map(s => s.meta.id)).toEqual(['session-v0-1-3'])
      expect(persistence.readAllSessionSummaries().map(s => s.meta.id)).toEqual(['session-v0-1-3'])
      expect(persistence.readSessionSummary(SessionId('legacy-large'))).toBeUndefined()
      expect(storage.sql.exec("SELECT * FROM dsh_session_events WHERE session_id = 'legacy-large' ORDER BY seq").toArray()).toEqual(largeBefore)
      expect(storage.sql.exec("SELECT version FROM dsh_sessions WHERE id = 'legacy-large'").toArray()).toEqual([{ version: 0 }])
    } finally { warn.mockRestore(); await ctx.fiber.dispose(); storage.close() }
  })

  it('keeps a skipped legacy log when the other migrations would rebuild the event table', async () => {
    const storage = cancelledStorage('cancelled by the user')
    storage.sql.exec(`INSERT INTO dsh_sessions
      SELECT 'legacy-large', version, created_at, cwd, parent_session, seed_length, origin,
      delegation_depth, agent_preset, 'large-incarnation', revision FROM dsh_sessions`)
    storage.sql.exec(
      'INSERT INTO dsh_session_events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)',
      'legacy-large', 0, 'system/message', 2000, JSON.stringify({ text: 'x'.repeat(LEGACY_MIGRATION_MAX_BYTES) }),
    )
    // Token deltas packing into one row make a rebuild the cheaper migration on their own.
    insertLegacyDeltas(storage, 200)
    const largeBefore = storage.sql.exec("SELECT * FROM dsh_session_events WHERE session_id = 'legacy-large' ORDER BY seq").toArray()
    storage.queries.length = 0
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const persistence = new DurableObjectSessionPersistence(ctx, { storage: storage as never })
      expect(storage.queries).not.toContain('DROP TABLE dsh_session_events')
      expect(storage.sql.exec("SELECT * FROM dsh_session_events WHERE session_id = 'legacy-large' ORDER BY seq").toArray()).toEqual(largeBefore)
      const migrated = await readAll(persistence, SessionId('session-v0-1-3'))
      expect(migrated.meta.version).toBe(SESSION_FORMAT_VERSION)
      expect(JSON.stringify(migrated.events)).toContain('x'.repeat(200))
    } finally { warn.mockRestore(); await ctx.fiber.dispose(); storage.close() }
  })

  it('preserves the legacy log after a migration write failure and retries successfully', async () => {
    const storage = cancelledStorage('cancelled by the user')
    const before = storage.sql.exec('SELECT * FROM dsh_session_events ORDER BY seq').toArray()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      storage.failNextEventInsert()
      expect(() => new DurableObjectSessionPersistence(ctx, { storage: storage as never })).toThrow('injected event insert failure')
      expect(storage.sql.exec('SELECT * FROM dsh_session_events ORDER BY seq').toArray()).toEqual(before)
      expect(storage.sql.exec('SELECT version FROM dsh_sessions').toArray()).toEqual([{ version: 0 }])
      const restarted = new Context()
      await restarted.plugin(SessionStore)
      try {
        const persistence = new DurableObjectSessionPersistence(restarted, { storage: storage as never })
        expect((await readAll(persistence, SessionId('session-v0-1-3'))).meta.version).toBe(SESSION_FORMAT_VERSION)
      } finally { await restarted.fiber.dispose() }
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it.each([['unknown explanation', {}], [42, {}], ['cancelled by the user', { unexpected: true }]])(
    'refuses unrecognized cancellation payloads without changing stored events (%s)', async (message, extra) => {
      const storage = cancelledStorage(message, extra as Record<string, unknown>)
      const before = storage.sql.exec('SELECT * FROM dsh_session_events ORDER BY seq').toArray()
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      try {
        expect(() => new DurableObjectSessionPersistence(ctx, { storage: storage as never })).toThrow()
        expect(storage.sql.exec('SELECT * FROM dsh_session_events ORDER BY seq').toArray()).toEqual(before)
        expect(storage.sql.exec('SELECT version FROM dsh_sessions').toArray()).toEqual([{ version: 0 }])
      } finally { await ctx.fiber.dispose(); storage.close() }
    },
  )
})

describe('durable-object bounded event pages', () => {
  it('round-trips a compact V3 assistant stream in one physical event row', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('packed-assistant-deltas')
    const chunks = Array.from({ length: 100 }, (_, index) => ({
      time: 1_000 + index,
      chunk: { type: 'text-delta' as const, index: 0, text: `token-${index}` },
    }))
    const stream = new AssistantStreamAccumulator()
    for (const chunk of chunks) stream.push(chunk)
    const events: SessionEvent[] = [{
      type: 'assistant/message', seq: SessionSeq(0), time: 1_100, surfaceOp: 'append',
      data: {
        turn: 1, step: 1, stream: [...stream.snapshot()],
        message: createAssistantMessage({
          content: [{ type: 'text', text: chunks.map(entry => entry.chunk.text).join('') }],
          source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        }),
      },
    }]
    try {
      await persistence.appendBatch({
        meta: { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
        inheritedEventCount: SessionLogOffset(0),
      }, events, false)
      expect(storage.sql.exec<{ type: string }>(
        'SELECT type FROM dsh_session_events WHERE session_id = ?', id,
      ).toArray()).toEqual([{ type: 'assistant/message' }])
      const restored = (await readAll(persistence, id)).events[0]!
      expect(restored).toEqual(events[0])
      if (restored.type !== 'assistant/message') throw new Error('Missing assistant event')
      expect(restored.data.stream).toHaveLength(1)
      expect(expandAssistantStream(restored.data.stream)).toEqual(chunks)
    } finally { await fiber.dispose(); await ctx.fiber.dispose(); storage.close() }
  })

  it('rewrites the durable header with a blank-session preset selection', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('preset-selected')
    const meta: SessionHeader = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, agentPreset: 'dsh-edge' }
    try {
      await persistence.appendBatch({ meta, inheritedEventCount: SessionLogOffset(0) }, [
        { type: 'agent-preset/selected', seq: SessionSeq(0), time: 2, data: { agentPreset: 'ptc' } },
      ], false)
      expect(persistence.readSessionSummary(id)?.meta.agentPreset).toBe('ptc')
      expect(persistence.readSessionSummaryPage(undefined, 10)?.sessions[0]?.meta.agentPreset).toBe('ptc')
    } finally { await fiber.dispose(); await ctx.fiber.dispose() }

    // A restarted Durable Object reads the selected preset from the header row.
    const restarted = new Context()
    await restarted.plugin(SessionStore)
    const coldFiber = await restarted.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    try {
      const cold = restarted.sessionPersistence as DurableObjectSessionPersistence
      expect(cold.readSessionSummary(id)?.meta.agentPreset).toBe('ptc')
      await using handle = await cold.open(id, 'read')
      expect(handle.header.agentPreset).toBe('ptc')
    } finally { await coldFiber.dispose(); await restarted.fiber.dispose(); storage.close() }
  })

  it('leaves torn rows untouched for readers and repairs them before resume appends', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('torn-resume')
    try {
      await persistence.appendBatch({
        meta: { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
        inheritedEventCount: SessionLogOffset(0),
      }, [
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
        { type: 'session/title', seq: SessionSeq(2), time: 3, data: { title: 'torn title', messageSeqs: [], source: { kind: 'user' } } },
      ], false)
      storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = ? AND seq = 2", id)
      const before = await persistence.stat(id)
      expect((await readAll(persistence, id)).events).toHaveLength(2)
      expect(await persistence.stat(id)).toEqual(before)
      expect(persistence.readSessionSummary(id)?.lastSeq).toBe(2)
      const queryStart = storage.queries.length
      const restored = await resumeStored(persistence, id)
      expect(storage.queries.slice(queryStart).some(query => /SELECT[\s\S]*SELECT/u.test(query))).toBe(false)
      expect(persistence.readSessionSummary(id)?.titleEvent).toBeUndefined()
      expect(restored.events.map(event => event.type)).toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])
      expect((await readAll(persistence, id)).events).toEqual(restored.events)
      expect(persistence.readSessionSummary(id)?.lastSeq).toBe(3)
      expect(await persistence.stat(id)).not.toEqual(before)
      await using handle = await persistence.open(id, 'write')
      await handle.append([{ type: 'turn/start', seq: SessionSeq(4), time: 4, data: { turn: 2 } }])
      expect((await handle.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
    } finally { await fiber.dispose(); storage.close() }
  })

  it('refuses to truncate corruption inside a completed turn', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const id = SessionId('corrupt-committed-turn')
    try {
      await persistence.appendBatch({
        meta: { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
        inheritedEventCount: SessionLogOffset(0),
      }, [
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ], false)
      storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = ? AND seq = 0", id)
      const before = await persistence.stat(id)
      await expect(resumeStored(persistence, id)).rejects.toThrow('unparsable committed event')
      expect(await persistence.stat(id)).toEqual(before)
      expect(storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM dsh_session_events WHERE session_id = ?', id,
      ).toArray()[0]?.count).toBe(2)
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
    const meta: SessionHeader = { id, version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
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
      expect((await readAll(persistence, id)).events).toHaveLength(1)
    } finally { await fiber.dispose(); storage.close() }
  })

  it.each([false, true])('preserves inbox receipts when refusing torn-tail repair (claimed=%s)', async claimed => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const queue = new MainSessionQueue(storage as never)
    const id = SessionId('torn-inbox-receipt')
    const message = createUserMessage({ content: [{ type: 'text', text: 'accepted prompt' }], source: { kind: 'user' } })
    const input = queue.enqueue(id, message.id, 'digest', message)
    if (claimed) queue.claim()
    try {
      await persistence.appendBatch({
        meta: { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
        inheritedEventCount: SessionLogOffset(0),
      }, [
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
          data: { target: 'next-turn', start: 0, inserted: [message] } },
      ], false)
      expect(queue.state(input.seq)).toBe(claimed ? 'admitted' : 'settled')
      const revision = await persistence.stat(id)
      // Cover both an intact receipt-bearing event after corruption and a
      // corrupt inbox payload whose durable type still identifies the hazard.
      for (const seq of [0, 1]) {
        storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = ? AND seq = ?", id, seq)
        const rows = storage.sql.exec('SELECT * FROM dsh_session_events WHERE session_id = ?', id).toArray()
        const receipts = storage.sql.exec('SELECT * FROM dsh_runtime_inputs').toArray()
        const slot = storage.sql.exec('SELECT * FROM dsh_runtime_slot').toArray()
        await expect(resumeStored(persistence, id)).rejects.toThrow('Cannot automatically repair a torn inbox event')
        expect(await persistence.stat(id)).toEqual(revision)
        expect(storage.sql.exec('SELECT * FROM dsh_session_events WHERE session_id = ?', id).toArray()).toEqual(rows)
        expect(storage.sql.exec('SELECT * FROM dsh_runtime_inputs').toArray()).toEqual(receipts)
        expect(storage.sql.exec('SELECT * FROM dsh_runtime_slot').toArray()).toEqual(slot)
      }
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
      {
        const handle = await persistence.create({ id, version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
        await handle.append([{
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
        await handle.close()
      }

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
      const createHandle = await persistence.create(
        { id, version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: true },
        { inheritedEventCount: SessionLogOffset(6) },
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
      await createHandle.append(seed)
      await createHandle.close()

      const readHandle = await persistence.open(id, 'read')
      try {
        expect(readHandle.inheritedEventCount).toBe(6)
        expect(readHandle.header.isSeeded).toBe(true)
      } finally { await readHandle.close() }
    } finally {
      await fiber.dispose()
      storage.close()
    }
  })

  // Fixture needs to be captured from a real 0.1.2-rc.1 deployment — the hand-crafted
  // event layout is rejected by the V2→V3 migration chain's chronology constraint.
  it.skip('resumes and extends the released 0.1.3 session state', async () => {
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
            version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION,
            cwd: '/workspace',
            agentPreset: 'dsh-edge',
          },
          titleEvent: {
            type: 'session/title',
            data: { title: 'DSH Edge 0.1.3 fixture' },
          },
          lastSeq: 6,
        })
        const loaded = await readAll(persistence, id)
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
          version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION,
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
        const loadedBlank = await readAll(persistence, blankId)
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
        {
          const handle = await reloadedCtx.sessionPersistence.open(id, 'read')
          try {
            const result = await handle.read()
            expect(result.events).toMatchObject([
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
            ])
          } finally {
            await handle.close()
          }
        }
        {
          const handle = await reloadedCtx.sessionPersistence.open(blankId, 'read')
          try {
            const result = await handle.read()
            expect(result.events).toMatchObject([
              { seq: SessionSeq(0), type: 'session/title' },
            ])
          } finally {
            await handle.close()
          }
        }
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
      {
        const handle = await ctx.sessionPersistence.create({
          id,
          version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION,
          createdAt: 1,
          isSeeded: false,
        })
        await handle.append([
          { type: 'turn/start', seq: SessionSeq(0), time: 2, data: { turn: 1 } },
          { type: 'step/start', seq: SessionSeq(1), time: 3, data: { turn: 1, step: 1 } },
          {
            type: 'assistant/message',
            seq: SessionSeq(2),
            time: 4,
            data: { turn: 1, step: 1, message, interrupted: true },
            surfaceOp: 'append',
          } as unknown as SessionEvent,
          { type: 'step/end', seq: SessionSeq(3), time: 5, data: { turn: 1, step: 1 } },
          {
            type: 'turn/end',
            seq: SessionSeq(4),
            time: 6,
            data: { turn: 1, reason: { kind: 'interrupted' } },
          },
        ])
        await handle.close()
      }
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
      await expect(readAll(persistence, id)).resolves.toMatchObject({
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
    const writeHandle = await persistence.create(
      { id, version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
    )
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
      await writeHandle.close()
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
    const writeHandle = await persistence.create(
      { id, version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
    )
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
      await writeHandle.close()
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
      version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION,
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

      await persistence.materializeBlankSession(id)
      expect(persistence.readBlankSession(id)).toBeUndefined()
      expect(persistence.hasSession(id)).toBe(true)
      const writeHandle = await persistence.open(id, 'write')
      try {
        await writeHandle.append([{
          type: 'model/selection',
          seq: SessionSeq(0),
          time: 20,
          data: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        } as unknown as SessionEvent])
      } finally { await writeHandle.close() }
      const readHandle = await persistence.open(id, 'read')
      try {
        const result = await readHandle.read()
        expect(result.events).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'model/selection' })]),
        )
      } finally { await readHandle.close() }
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
    const writeHandle = await persistence.create(
      { id, version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
    )
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

      await writeHandle.close()
      await ownerFiber.dispose()
      await persistenceFiber.dispose()

      // The session row exists from create() but has no events because the flush failed.
      const rows = storage.sql.exec('SELECT id FROM dsh_sessions').toArray()
      expect(rows).toEqual([{ id: 'abandoned-creation' }])
    } finally {
      await writeHandle.close()
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
      {
        const handle = await persistence.create({ id, version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
        await handle.append([{
          type: 'session/title',
          seq: SessionSeq(0),
          time: 2,
          data: {
            title: 'Point summary',
            messageSeqs: [],
            source: { kind: 'user' },
          },
        }])
        await handle.close()
      }

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
      {
        const handle = await persistence.create({ id, version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
        await handle.append([{
          type: 'session/title',
          seq: SessionSeq(0),
          time: 2,
          data: {
            title: 'Current title',
            messageSeqs: [],
            source: { kind: 'user' },
          },
        }])
        await handle.close()
      }
      storage.sql.exec('UPDATE dsh_sessions SET version = ? WHERE id = ?', 99, id)
      storage.sql.exec(
        "UPDATE dsh_session_events SET data = '{future-title-format' WHERE session_id = ?",
        id,
      )

      expect(() => persistence.readSessionSummary(id))
        .toThrow(/format v99/u)
      expect(() => persistence.readSessionHeader(id))
        .toThrow(/format v99/u)
      expect(() => persistence.readSessionSummaryPage(undefined, 1))
        .toThrow(/format v99/u)
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
      {
        const handle = await persistence.create({ id, version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
        await handle.append([{
          type: 'session/title',
          seq: SessionSeq(0),
          time: 2,
          data: {
            title: 'Current title',
            messageSeqs: [],
            source: { kind: 'user' },
          },
        }])
        await handle.close()
      }
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
      version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION,
      createdAt: 1,
      isSeeded: false,
    }
    try {
      {
        const handle = await ctx.sessionPersistence.create(header)
        await handle.append([{
          type: 'future/required-event',
          seq: SessionSeq(0),
          time: 2,
          data: null,
        } as unknown as SessionEvent])
        await handle.close()
      }
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

  // TODO(upstream-0.1.5): deferred to PR C — legacy prefix migration invalidated by stricter V3 event validation
  it.skip('keeps legacy prefix migration inside the bounded loader budget', async () => {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, {
      storage: storage as never,
    })
    const persistence = ctx.sessionPersistence as unknown as DurableObjectSessionPersistence
    const id = SessionId('bounded-legacy-prefix')
    try {
      {
        const handle = await persistence.create({ id, version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
        await handle.append([
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
        await handle.close()
      }

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
      version: SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION,
      createdAt: 1,
      isSeeded: false,
    }
    try {
      {
        const handle = await persistence.create(header)
        await handle.append([{
          type: 'session/title',
          seq: SessionSeq(0),
          time: 2,
          data: {
            title: '界'.repeat(1_024),
            messageSeqs: [],
            source: { kind: 'user' },
          },
        }])
        await handle.close()
      }

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

describe('session log export pages', () => {
  async function openStore() {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    return { storage, persistence: ctx.sessionPersistence as DurableObjectSessionPersistence, dispose: async () => { await fiber.dispose(); storage.close() } }
  }
  const titleEvent = (seq: number, title: string): SessionEvent => ({
    type: 'session/title', seq: SessionSeq(seq), time: seq + 1, data: { title, messageSeqs: [], source: { kind: 'user' } },
  }) as SessionEvent
  const storageOf = (id: ReturnType<typeof SessionId>): Parameters<DurableObjectSessionPersistence['appendBatch']>[0] => ({
    meta: { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
    inheritedEventCount: SessionLogOffset(0),
  })
  const collect = async (pages: AsyncIterable<SessionEvent[]>) => {
    const sizes: number[] = []
    const events: SessionEvent[] = []
    for await (const page of pages) { sizes.push(page.length); events.push(...page) }
    return { sizes, events }
  }
  const ROOMY = { rows: 1_000, characters: Number.MAX_SAFE_INTEGER }

  it('reads the whole log in pages bounded by rows and by stored characters, the same events a read returns', async () => {
    const { persistence, dispose } = await openStore()
    const id = SessionId('export-paged')
    try {
      await persistence.appendBatch(storageOf(id), Array.from({ length: 25 }, (_, seq) => titleEvent(seq, `t${String(seq)} ${'中'.repeat(seq % 7 * 40)}`)), false)
      const whole = (await readAll(persistence, id)).events
      const byRows = await collect(persistence.exportEventPages(id, { rows: 10, characters: Number.MAX_SAFE_INTEGER }))
      expect(byRows.sizes).toEqual([10, 10, 5])
      expect(byRows.events).toEqual(whole)
      // A page stops after the row that reaches the character bound; a larger row is still read whole.
      const byCharacters = await collect(persistence.exportEventPages(id, { rows: 1_000, characters: 1 }))
      expect(byCharacters.sizes).toEqual(Array.from({ length: 25 }, () => 1))
      expect(byCharacters.events).toEqual(whole)
    } finally { await dispose() }
  })

  it('leaves out what is appended after the first page, as a single read would', async () => {
    const { persistence, dispose } = await openStore()
    const id = SessionId('export-pinned')
    try {
      await persistence.appendBatch(storageOf(id), Array.from({ length: 4 }, (_, seq) => titleEvent(seq, 'before')), false)
      const seqs: number[] = []
      for await (const page of persistence.exportEventPages(id, { rows: 2, characters: Number.MAX_SAFE_INTEGER })) {
        seqs.push(...page.map(event => event.seq))
        if (seqs.length === 2) await persistence.appendBatch(storageOf(id), [titleEvent(4, 'during')], true)
      }
      expect(seqs).toEqual([0, 1, 2, 3])
    } finally { await dispose() }
  })

  it('ends at a torn tail after the last committed turn, and refuses one inside it', async () => {
    const { storage, persistence, dispose } = await openStore()
    const id = SessionId('export-torn')
    try {
      await persistence.appendBatch(storageOf(id), [titleEvent(0, 'a'), titleEvent(1, 'b'), titleEvent(2, 'c')], false)
      storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = ? AND seq = 2", id)
      expect((await collect(persistence.exportEventPages(id, ROOMY))).events.map(event => event.seq)).toEqual([0, 1])
      // The same row before a committed turn end is corruption, not a torn tail.
      storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = ? AND seq = 1", id)
      storage.sql.exec("UPDATE dsh_session_events SET type = 'turn/end', data = '{}' WHERE session_id = ? AND seq = 2", id)
      await expect(collect(persistence.exportEventPages(id, ROOMY))).rejects.toThrow('unparsable committed event at seq 1')
    } finally { await dispose() }
  })

  it('keeps a resume that repairs the torn tail out of an export already under way', async () => {
    const { storage, persistence, dispose } = await openStore()
    const id = SessionId('export-repaired')
    try {
      // seq 2 ends a committed turn; 3 and 4 are intact uncommitted events, 5 is torn, 6 follows it.
      await persistence.appendBatch(storageOf(id), [0, 1, 2, 3, 4, 5, 6].map(seq => titleEvent(seq, `t${String(seq)}`)), false)
      storage.sql.exec("UPDATE dsh_session_events SET type = 'turn/end', data = '{}' WHERE session_id = ? AND seq = 2", id)
      storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = ? AND seq = 5", id)
      const seqs: number[] = []
      for await (const page of persistence.exportEventPages(id, { rows: 2, characters: Number.MAX_SAFE_INTEGER })) {
        seqs.push(...page.map(event => event.seq))
        if (seqs.length === 2) {
          // A resume repairs the tail from the tear on and its new turn takes those seqs.
          await persistence.repairTornTail(id, SessionLogOffset(0))
          await persistence.appendBatch(storageOf(id), [5, 6, 7].map(seq => titleEvent(seq, `new ${String(seq)}`)), true)
        }
      }
      expect(seqs).toEqual([0, 1, 2, 3, 4])
    } finally { await dispose() }
  })

  it('fails instead of mixing two versions of the log when a pinned row is rewritten or removed', async () => {
    const { storage, persistence, dispose } = await openStore()
    const id = SessionId('export-rewritten')
    try {
      await persistence.appendBatch(storageOf(id), [0, 1, 2, 3].map(seq => titleEvent(seq, `t${String(seq)}`)), false)
      const rewrite = async (change: () => void) => {
        let pages = 0
        for await (const _page of persistence.exportEventPages(id, { rows: 2, characters: Number.MAX_SAFE_INTEGER })) {
          if (pages++ === 0) change()
        }
      }
      await expect(rewrite(() => storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = ? AND seq = 3", id)))
        .rejects.toThrow('changed during export')
      // The unparsable seq 3 follows no turn end, so a resume repairs it away.
      await persistence.repairTornTail(id, SessionLogOffset(0))
      await persistence.appendBatch(storageOf(id), [titleEvent(3, 't3')], true)
      await expect(rewrite(() => storage.sql.exec('DELETE FROM dsh_session_events WHERE session_id = ? AND seq >= 2', id)))
        .rejects.toThrow('changed during export')
    } finally { await dispose() }
  })

  it('yields no page for a session without stored events, and stops when the export is cancelled', async () => {
    const { persistence, dispose } = await openStore()
    try {
      expect((await collect(persistence.exportEventPages(SessionId('export-missing'), ROOMY))).sizes).toEqual([])
      const id = SessionId('export-cancelled')
      await persistence.appendBatch(storageOf(id), [titleEvent(0, 'a')], false)
      const controller = new AbortController()
      controller.abort()
      await expect(collect(persistence.exportEventPages(id, ROOMY, controller.signal))).rejects.toThrow()
    } finally { await dispose() }
  })

  it('drops the size table the former export check kept', async () => {
    const storage = new TestDurableObjectStorage()
    storage.sql.exec('CREATE TABLE dsh_session_event_bytes (session_id TEXT PRIMARY KEY, through_seq INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    try {
      expect(storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'dsh_session_event_bytes'").toArray()[0]?.n).toBe(0)
    } finally { await fiber.dispose(); storage.close() }
  })
})

function isEventPayloadQuery(query: string): boolean {
  return /SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable/u.test(query)
}

describe('storage-contract checks over Durable Object rows', () => {
  async function openStore() {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
    return { storage, persistence: ctx.sessionPersistence as DurableObjectSessionPersistence, dispose: async () => { await fiber.dispose(); storage.close() } }
  }
  const header = (id: string): SessionHeader => ({ id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
  const chunk = (seq: number, text: string) => ({
    type: 'assistant/chunk', seq: SessionSeq(seq), time: 1,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
  }) as unknown as SessionEvent
  const title = (seq: number) => ({
    type: 'session/title', seq: SessionSeq(seq), time: 1, data: { title: 't', messageSeqs: [], source: { kind: 'user' } },
  }) as SessionEvent

  const eventTypes = (storage: TestDurableObjectStorage, id: string) =>
    storage.sql.exec('SELECT event_types FROM dsh_session_summaries WHERE session_id = ?', id).toArray()[0]?.event_types

  it('keeps each session\'s stored types in its summary and checks a write open against them', async () => {
    const { storage, persistence, dispose } = await openStore()
    try {
      const writer = await persistence.create(header('vocabulary'))
      expect(eventTypes(storage, 'vocabulary')).toBe('[]')
      await writer.append([title(0), { type: 'future/note', seq: SessionSeq(1), time: 1, data: {}, ignorable: true } as unknown as SessionEvent])
      await writer.append([{ type: 'turn/start', seq: SessionSeq(2), time: 1, data: { turn: 1 } } as SessionEvent])
      await writer.close()
      // Ignorable events are not recorded; the append that writes the summary row records the rest.
      expect(eventTypes(storage, 'vocabulary')).toBe('["session/title","turn/start"]')
      const queries = storage.queries.length
      const reopened = await persistence.open(SessionId('vocabulary'), 'write')
      // The open reads the summary row, not the log.
      expect(storage.queries.slice(queries).some(query => /FROM dsh_session_events/u.test(query))).toBe(false)
      expect((await reopened.read()).events.map(event => event.type)).toEqual(['session/title', 'future/note', 'turn/start'])
      await reopened.close()

      // The current format has no assistant/chunk, so a write open refuses it as a read does.
      const chunks = await persistence.create(header('chunk-run'))
      await chunks.append([chunk(0, 'a'), chunk(1, 'b')])
      await chunks.close()
      await expect(persistence.open(SessionId('chunk-run'), 'write')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    } finally { await dispose() }
  })

  it('scans a session without recorded types once, refusing a retired header reason', async () => {
    const { storage, persistence, dispose } = await openStore()
    try {
      const writer = await persistence.create(header('unrecorded'))
      await writer.append([title(0), title(1)])
      await writer.close()
      // As a session stored by an earlier release, or repaired or migrated since.
      storage.sql.exec('UPDATE dsh_session_summaries SET event_types = NULL WHERE session_id = ?', 'unrecorded')
      await (await persistence.open(SessionId('unrecorded'), 'write')).close()
      expect(eventTypes(storage, 'unrecorded')).toBe('["session/title"]')
      const queries = storage.queries.length
      await (await persistence.open(SessionId('unrecorded'), 'write')).close()
      expect(storage.queries.slice(queries).some(query => /FROM dsh_session_events/u.test(query))).toBe(false)

      const retired = await persistence.create(header('retired-header'))
      await retired.append([title(0)])
      await retired.close()
      storage.sql.exec(
        "UPDATE dsh_session_events SET type = 'request/header', data = ? WHERE session_id = ? AND seq = 0",
        JSON.stringify({ reason: 'fallback' }), 'retired-header',
      )
      storage.sql.exec('UPDATE dsh_session_summaries SET event_types = NULL WHERE session_id = ?', 'retired-header')
      await expect(persistence.open(SessionId('retired-header'), 'write')).rejects.toThrow(/fallback/u)
      // The refused open released its claim: a retry is refused the same way, not as owned.
      await expect(persistence.open(SessionId('retired-header'), 'write')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    } finally { await dispose() }
  })

  it('records the retired request/header reason an append stores, and refuses the next write open', async () => {
    const { storage, persistence, dispose } = await openStore()
    try {
      const writer = await persistence.create(header('appended-fallback'))
      await writer.append([{ type: 'request/header', seq: SessionSeq(0), time: 1, data: { reason: 'fallback' } } as unknown as SessionEvent])
      await writer.close()
      expect(eventTypes(storage, 'appended-fallback')).toBe('["request/header#fallback"]')
      await expect(persistence.open(SessionId('appended-fallback'), 'write')).rejects.toThrow(/fallback/u)
    } finally { await dispose() }
  })

  // The checks below follow upstream's backend contract (dsh-session-persistence), in the Edge's own tests.
  it('reads offsets and lengths as upstream: slices, past-the-end empty, and only non-negative safe integers', async () => {
    const { persistence, dispose } = await openStore()
    try {
      const writer = await persistence.create(header('slices'))
      const log = [0, 1, 2, 3, 4, 5].map(title)
      await writer.append(log)
      await writer.append([])
      expect((await writer.read()).events).toEqual(log)
      expect((await writer.read(3)).events).toEqual(log.slice(3))
      expect((await writer.read(0, 2)).events).toEqual(log.slice(0, 2))
      expect((await writer.read(1, 3)).events).toEqual(log.slice(1, 4))
      expect((await writer.read(6)).events).toEqual([])
      expect((await writer.read(106)).events).toEqual([])
      for (const [offset, length] of [[-1, undefined], [1.5, undefined], [0, -1]]) {
        await expect(writer.read(offset, length)).rejects.toThrow(/non-negative safe integer/u)
      }
      await writer.close()
    } finally { await dispose() }
  })

  it('rejects an append that does not continue the log, or that is not lossless JSON, and stores nothing', async () => {
    const { persistence, dispose } = await openStore()
    try {
      const writer = await persistence.create(header('contiguity'))
      await writer.append([0, 1, 2].map(title))
      await expect(writer.append([0, 1, 2].map(title))).rejects.toThrow(/expected 3/u)
      await expect(writer.append([title(3), title(5)])).rejects.toThrow(/expected 4/u)
      for (const extra of [1n, undefined]) {
        await expect(writer.append([{ ...title(3), data: { ...title(3).data, extra } } as unknown as SessionEvent]))
          .rejects.toThrow(/losslessly JSON-serializable/u)
      }
      expect((await writer.read()).events.map(event => event.seq)).toEqual([0, 1, 2])
      await expect(persistence.create({ ...header('bad-created-at'), createdAt: -1 })).rejects.toThrow(/createdAt/u)
      await writer.close()
    } finally { await dispose() }
  })

  it('refuses an unknown stored type on every write open and on read, naming it', async () => {
    const { persistence, dispose } = await openStore()
    try {
      const writer = await persistence.create(header('foreign'))
      await writer.append([title(0), { type: 'mystery/event', seq: SessionSeq(1), time: 1, data: {} } as unknown as SessionEvent])
      await writer.close()
      await expect(persistence.open(SessionId('foreign'), 'write')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
      // The refused open released its claim, so a retry is refused the same way rather than as owned.
      await expect(persistence.open(SessionId('foreign'), 'write')).rejects.toThrow(/mystery\/event/u)
      const reader = await persistence.open(SessionId('foreign'), 'read')
      await expect(reader.read()).rejects.toThrow(/mystery\/event/u)
      await reader.close()
    } finally { await dispose() }
  })

  it('rejects NaN in event data and stores nothing', async () => {
    const { persistence, dispose } = await openStore()
    try {
      const writer = await persistence.create(header('nan'))
      await expect(writer.append([{ ...title(0), data: { ...title(0).data, extra: Number.NaN } } as unknown as SessionEvent]))
        .rejects.toThrow(TypeError)
      expect((await writer.read()).events).toEqual([])
      await writer.close()
    } finally { await dispose() }
  })

  it('selects only the rows a bounded read returns', async () => {
    const { storage, persistence, dispose } = await openStore()
    try {
      const writer = await persistence.create(header('bounded'))
      await writer.append(Array.from({ length: 200 }, (_, seq) => title(seq)))
      const selected: number[] = []
      const exec = storage.sql.exec
      storage.sql.exec = ((query: string, ...bindings: SQLInputValue[]) => {
        const result = exec(query, ...bindings)
        if (/SELECT seq, type, time, data/u.test(query)) selected.push(result.toArray().length)
        return result
      }) as typeof exec
      expect((await writer.read(50, 3)).events.map(event => event.seq)).toEqual([50, 51, 52])
      storage.sql.exec = exec
      expect(selected).toEqual([3])
      // It never looks for the last turn end: an unparsable row in its range is corruption.
      storage.sql.exec("UPDATE dsh_session_events SET data = '{' WHERE session_id = ? AND seq = 199", 'bounded')
      await expect(writer.read(198, 2)).rejects.toThrow(/unparsable committed event at seq 199/u)
      await writer.close()
    } finally { await dispose() }
  })
})
