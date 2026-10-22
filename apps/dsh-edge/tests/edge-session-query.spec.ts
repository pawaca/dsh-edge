import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { describe, expect, it, vi } from 'vitest'
import DurableObjectSessionPersistence from '../src/do-session-persistence.ts'
import EdgeSessionQuery, { READ_EVENT_MAX_STORED_BYTES, TRACE_EVENT_MAX_EVENTS, TRACE_SESSION_MAX_SESSIONS, TRACE_EVENT_MAX_STORED_CHARACTERS, edgeSearchDocuments } from '../src/edge-session-query.ts'
import type {} from '../src/upstream-message-sources.ts'
import { TestDurableObjectStorage } from './main-session-queue.spec.ts'

function userMessage(seq: number, text: string, source: Record<string, unknown>): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 1_000 + seq,
    surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text }], source: source as never }),
  } as unknown as SessionEvent
}

describe('Edge session search documents', () => {
  it('indexes what the owner said and leaves injected context out', () => {
    const events = [
      userMessage(0, 'owner asks about rivers', { kind: 'user' }),
      userMessage(1, 'Current date: Tuesday', { kind: 'runtime-context', form: 'snapshot', sections: [] }),
      userMessage(2, 'skills available: greet-owner', { kind: 'skill-catalog', form: 'catalog', entries: [] }),
      userMessage(3, 'The bash command may still be running', { kind: 'edge-shell', form: 'notice', summary: 'still running' }),
      userMessage(4, 'recalled from another session', { kind: 'session-reference', form: 'recall', version: 1, references: [] }),
      userMessage(5, 'reminder: water the plants', { kind: 'schedule' }),
    ]
    expect(edgeSearchDocuments(SessionId('s'), events).map(document => document.text))
      .toEqual(['owner asks about rivers', 'reminder: water the plants'])
  })
})

describe('Edge session query reads of cold sessions', () => {
  const EVENTS = 300

  async function harness() {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never }).await()
    await ctx.plugin(EdgeSessionQuery)
    const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
    const engine = ctx.sessionQuery as EdgeSessionQuery
    const id = SessionId('cold')
    const other = SessionId('other')
    const events: SessionEvent[] = Array.from({ length: EVENTS }, (_, seq) => userMessage(seq, `message ${String(seq)}`, { kind: 'user' }))
    events.push({ type: 'session/title', seq: SessionSeq(EVENTS), time: 5_000, data: { title: 'Cold notes', messageSeqs: [], source: { kind: 'user' } } } as never)
    await persistence.appendBatch({ meta: { id, version: SESSION_FORMAT_VERSION, createdAt: 2, isSeeded: false, cwd: '/workspace' }, inheritedEventCount: SessionLogOffset(0) }, events, false)
    await persistence.appendBatch({ meta: { id: other, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/elsewhere' }, inheritedEventCount: SessionLogOffset(0) }, [userMessage(0, 'hello', { kind: 'user' })], false)
    const calls = {
      list: vi.spyOn(persistence, 'list'),
      open: vi.spyOn(persistence, 'open'),
      page: vi.spyOn(persistence, 'readEventPage'),
    }
    const upstream = SessionQueryEngine.prototype
    return { ctx, storage, persistence, engine, id, other, calls, upstream }
  }

  it('reads one event and its neighbors in three bounded pages, as upstream reads it from the whole log', async () => {
    const { ctx, storage, engine, id, calls, upstream } = await harness()
    try {
      const window = await engine.readEvent({ sessionId: id, seq: SessionSeq(150), before: 2, after: 3 })
      expect(calls.page).toHaveBeenCalledTimes(3)
      expect(window.events.map(event => event.seq)).toEqual([148, 149, 150, 151, 152, 153])
      expect(window).toEqual(await upstream.readEvent.call(engine, { sessionId: id, seq: SessionSeq(150), before: 2, after: 3 }))
      // At the log's edges the window stops where the log does.
      const edge = await engine.readEvent({ sessionId: id, seq: SessionSeq(EVENTS), before: 0, after: 5 })
      expect([edge.startSeq, edge.endSeq]).toEqual([EVENTS, EVENTS])
      await expect(engine.readEvent({ sessionId: id, seq: SessionSeq(EVENTS + 1) })).rejects.toMatchObject({ code: 'SESSION_QUERY_EVENT_NOT_FOUND' })
      await expect(engine.readEvent({ sessionId: id, seq: SessionSeq(1), before: 51 })).rejects.toMatchObject({ code: 'SESSION_QUERY_INVALID_WINDOW' })
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it('counts cited source sequences toward the read budget before decoding a row', async () => {
    const { ctx, storage, persistence, engine, id } = await harness()
    try {
      const huge = '[' + '1,'.repeat(READ_EVENT_MAX_STORED_BYTES / 2) + '1]'
      storage.sql.exec('UPDATE dsh_session_events SET source_event_seqs = ? WHERE session_id = ? AND seq = 10', huge, id)
      // The oversized row's payload is never selected: only its size is read.
      const exec = vi.spyOn(storage.sql, 'exec')
      await expect(engine.readEvent({ sessionId: id, seq: SessionSeq(10) })).rejects.toThrow(/read limit/u)
      expect(exec.mock.calls.some(([query]) => String(query).includes('LENGTH(CAST(data AS BLOB))'))).toBe(true)
      expect(exec.mock.calls.filter(([query]) => String(query).includes('SELECT seq, type, time, data'))).toEqual([])
      // Other readers (the history pages) keep one query per page: no size pass.
      exec.mockClear()
      await persistence.readEventPage(id, 20, 10, 1024 * 1024)
      expect(exec.mock.calls.some(([query]) => String(query).includes('LENGTH(CAST(data AS BLOB))'))).toBe(false)
      exec.mockRestore()
      // A neighbor over the budget is left out rather than decoded.
      const window = await engine.readEvent({ sessionId: id, seq: SessionSeq(11), before: 1 })
      expect(window.events.map(event => event.seq)).toEqual([11])
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it('reads cold titles from the summary row, not the log', async () => {
    const { ctx, storage, engine, id, other, calls, upstream } = await harness()
    try {
      const missing = SessionId('missing')
      const results = await engine.readTitleSnapshots([id, other, missing, id])
      expect(calls.open).not.toHaveBeenCalled()
      expect(calls.page).not.toHaveBeenCalled()
      const expected = await upstream.readTitleSnapshots.call(engine, [id, other, missing])
      expect(results.slice(0, 2)).toEqual(expected.slice(0, 2))
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { title: { title: 'Cold notes' } } })
      expect(results[2]).toMatchObject({ status: 'rejected', reason: { code: 'SESSION_QUERY_SESSION_NOT_FOUND' } })
      expect(results).toHaveLength(3)
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it('authorizes by id without listing every stored session', async () => {
    const { ctx, storage, engine, id, other, calls, upstream } = await harness()
    try {
      const filters = [{ kind: 'id' as const, values: [id, other, SessionId('missing')] }, { kind: 'cwd' as const, values: ['/workspace'] }]
      const records = await engine.filterSessions(filters)
      expect(calls.list).not.toHaveBeenCalled()
      expect(records).toEqual(await upstream.filterSessions.call(engine, filters))
      expect(records.map(record => record.header.id)).toEqual([id])
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it('refuses to trace a cold log over the event cap before loading it', async () => {
    const { ctx, storage, persistence, engine, id, calls } = await harness()
    try {
      expect((await engine.traceEvent({ sessionId: id, seq: SessionSeq(3) })).session.id).toBe(id)
      calls.open.mockClear()
      const summary = persistence.readSessionSummary(id)!
      vi.spyOn(persistence, 'readSessionSummary').mockReturnValue({ ...summary, lastSeq: TRACE_EVENT_MAX_EVENTS })
      await expect(engine.traceEvent({ sessionId: id, seq: SessionSeq(3) })).rejects.toThrow(/trace limit/u)
      expect(calls.open).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it('traces lineage only while the stored corpus is within the listing cap', async () => {
    const { ctx, storage, persistence, engine, id, calls } = await harness()
    try {
      expect(persistence.sessionCountUpTo(TRACE_SESSION_MAX_SESSIONS)).toBe(2)
      expect(persistence.sessionCountUpTo(1)).toBe(2)
      expect((await engine.traceSession(id)).target.header.id).toBe(id)
      calls.list.mockClear()
      vi.spyOn(persistence, 'sessionCountUpTo').mockReturnValue(TRACE_SESSION_MAX_SESSIONS + 1)
      await expect(engine.traceSession(id)).rejects.toThrow(/lineage trace limit/u)
      expect(calls.list).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose(); storage.close() }
  })

  it('refuses to trace a short cold log whose stored events are over the size cap', async () => {
    const { ctx, storage, persistence, engine, id, calls } = await harness()
    try {
      // The aggregate counts the stored rows' characters without decoding them,
      // the cited source sequences included.
      const rows = storage.sql.exec<{ data: string, seqs: string | null }>(
        'SELECT data, source_event_seqs AS seqs FROM dsh_session_events WHERE session_id = ?', id,
      ).toArray()
      expect(persistence.storedEventCharacters(id)).toBe(rows.reduce((total, row) => total + row.data.length + (row.seqs?.length ?? 0), 0))
      storage.sql.exec("UPDATE dsh_session_events SET source_event_seqs = ? WHERE session_id = ? AND seq = 0", '[' + '1,'.repeat(5_000) + '1]', id)
      expect(persistence.storedEventCharacters(id)).toBeGreaterThan(10_000)
      expect(persistence.storedEventCharacters(SessionId('missing'))).toBe(0)
      vi.spyOn(persistence, 'storedEventCharacters').mockReturnValue(TRACE_EVENT_MAX_STORED_CHARACTERS + 1)
      await expect(engine.traceEvent({ sessionId: id, seq: SessionSeq(3) })).rejects.toThrow(/stored characters/u)
      expect(calls.open).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose(); storage.close() }
  })
})
