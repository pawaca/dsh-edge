/** Live-preferred session query engine over the Edge Durable Object persistence. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine, {
  buildSessionEventSearchDocuments,
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
  type SessionEventResultFilter,
  type SessionEventSearchDocument,
  type SessionEventSearchHit,
  type SessionEventSearchPage,
  type SessionEventSearchRequest,
  type SessionRecord,
  type SessionSearchExecContext,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import type DurableObjectSessionPersistence from './do-session-persistence.ts'

const MAX_SEARCH_SESSIONS = 32
const MAX_SEARCH_EVENTS_PER_SESSION = 512
const MAX_SEARCH_STORED_BYTES_PER_SESSION = 256 * 1_024
const SNIPPET_MAX_CODE_POINTS = 240

/** Bounded plain-text excerpt around the first case-insensitive query match. */
function snippetOf(text: string, query: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  const index = query === '' ? 0 : normalized.toLowerCase().indexOf(query.toLowerCase())
  const points = Array.from(normalized)
  if (index <= 0) return points.slice(0, SNIPPET_MAX_CODE_POINTS).join('')
  const prefixPoints = Array.from(normalized.slice(0, index)).length
  const start = Math.max(0, prefixPoints - Math.floor(SNIPPET_MAX_CODE_POINTS / 4))
  return points.slice(start, start + SNIPPET_MAX_CODE_POINTS).join('')
}

function hitOf(document: SessionEventSearchDocument, query: string): SessionEventSearchHit {
  return {
    sessionId: document.sessionId,
    seq: document.seq,
    type: document.type,
    time: document.time,
    surface: document.surface,
    snippet: snippetOf(document.text, query),
  }
}

/**
 * The base engine implements observation, listing, tracing, and filtering on
 * the `sessionPersistence` seam that `DurableObjectSessionPersistence` already
 * serves; only the two full-text entry points are provider-specific.
 *
 * Both entry points reuse the upstream filter semantics but never enumerate
 * the persistence corpus or materialize a complete event log: candidates come
 * from the bounded recent-summaries index and every log read goes through the
 * bounded validated page reader, mirroring the pre-upgrade Edge search limits.
 * Sessions whose retained log exceeds those bounds are excluded from
 * cross-session search, exactly like the previous Edge implementation.
 */
export class EdgeSessionQuery extends SessionQueryEngine {
  constructor(ctx: Context) {
    super(ctx)
  }

  private edgePersistence(): DurableObjectSessionPersistence | undefined {
    return this.ctx.get('sessionPersistence') as DurableObjectSessionPersistence | undefined
  }

  /** Bounded newest-first candidate records without enumerating the corpus. */
  private boundedCandidates(persistence: DurableObjectSessionPersistence): SessionRecord[] {
    const records = new Map<SessionId, SessionRecord>()
    for (const session of this.ctx.sessions.list()) {
      records.set(session.id, {
        header: structuredClone(session.header) as SessionHeader,
        live: true,
        persisted: persistence.readSessionHeader(session.id) !== undefined,
      })
    }
    for (const summary of persistence.readRecentSessionSummaries(MAX_SEARCH_SESSIONS)) {
      if (records.has(summary.meta.id)) continue
      records.set(summary.meta.id, { header: summary.meta, live: false, persisted: true })
    }
    return [...records.values()].slice(0, MAX_SEARCH_SESSIONS)
  }

  /**
   * Read one session's events within the Edge search budget.
   * @returns the bounded log, or `undefined` when it exceeds the budget.
   */
  private async boundedEvents(
    id: SessionId,
    signal: AbortSignal | undefined,
    persistence: DurableObjectSessionPersistence,
  ): Promise<readonly SessionEvent[] | undefined> {
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) {
      await this.ctx.sessions.flush(live)
      const events = live.snapshotEvents()
      return events.length > MAX_SEARCH_EVENTS_PER_SESSION ? undefined : events
    }
    const page = await persistence.readEventPage(
      id,
      0,
      MAX_SEARCH_EVENTS_PER_SESSION,
      MAX_SEARCH_STORED_BYTES_PER_SESSION,
      signal,
    )
    return page.hasMore ? undefined : page.events
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    const signal = exec?.signal
    signal?.throwIfAborted()
    const persistence = this.edgePersistence()
    if (persistence === undefined) return { items: [] }
    const limit = Math.max(1, Math.floor(request.limit ?? 20))
    const query = request.query.trim()
    const filters = materializeSessionEventResultFilters(
      this.searchFilters(request.eventFilters ?? [], query),
    )
    const candidates = filterSessionResults(
      this.boundedCandidates(persistence),
      materializeSessionResultFilters(request.sessionFilters ?? []),
    )
    const items: SessionSearchHit[] = []
    for (const record of candidates) {
      signal?.throwIfAborted()
      if (items.length >= limit) break
      let events: readonly SessionEvent[] | undefined
      try {
        events = await this.boundedEvents(record.header.id, signal, persistence)
      } catch {
        // A corrupt or concurrently-deleted log never fails the whole search.
        continue
      }
      if (events === undefined) continue
      const documents = filterSessionEventDocuments(
        buildSessionEventSearchDocuments(record.header.id, events),
        filters,
      )
      const best = documents.at(-1)
      if (best === undefined) continue
      items.push({ ...record, bestMatch: hitOf(best, query) })
    }
    return { items }
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    const signal = exec?.signal
    signal?.throwIfAborted()
    const persistence = this.edgePersistence()
    const live = this.ctx.sessions.get(request.sessionId)
    const session = live !== undefined
      ? structuredClone(live.header) as SessionHeader
      : persistence?.readSessionHeader(request.sessionId)
    if (session === undefined || persistence === undefined) {
      throw new Error(`session "${request.sessionId}" is not available for search`)
    }
    const limit = Math.max(1, Math.floor(request.limit ?? 50))
    const query = request.query.trim()
    // In-session search scans the bounded leading page of an oversized log
    // instead of failing; the budget mirrors the cross-session limits.
    let events: readonly SessionEvent[]
    if (live !== undefined) {
      await this.ctx.sessions.flush(live)
      events = live.snapshotEvents().slice(0, MAX_SEARCH_EVENTS_PER_SESSION)
    } else {
      const page = await persistence.readEventPage(
        request.sessionId,
        0,
        MAX_SEARCH_EVENTS_PER_SESSION,
        MAX_SEARCH_STORED_BYTES_PER_SESSION,
        signal,
      )
      events = page.events
    }
    const documents = filterSessionEventDocuments(
      buildSessionEventSearchDocuments(request.sessionId, events),
      materializeSessionEventResultFilters(this.searchFilters(request.filters ?? [], query)),
    )
    return {
      items: documents.slice(-limit).map(document => hitOf(document, query)),
      session,
    }
  }

  private searchFilters(
    metadata: readonly SessionEventResultFilter[],
    query: string,
  ): SessionEventResultFilter[] {
    return query === '' ? [...metadata] : [...metadata, { kind: 'text', text: query }]
  }
}

export default EdgeSessionQuery
