/** Live-preferred session query engine over the Edge Durable Object persistence. */

import type { Context } from '@deepseek-ai/cordis'
import { snapshotSessionEvent, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine, {
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  buildSessionEventSearchDocuments,
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
  type SessionEventReadRequest,
  type SessionEventResultFilter,
  type SessionEventTraceObservation,
  type SessionEventTraceRequest,
  type SessionEventWindow,
  type SessionEventSearchDocument,
  type SessionEventSearchHit,
  type SessionEventSearchPage,
  type SessionEventSearchRequest,
  type SessionRecord,
  type SessionResultFilter,
  type SessionSearchExecContext,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchRequest,
  type SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type DurableObjectSessionPersistence from './do-session-persistence.ts'
import type {} from './upstream-message-sources.ts'

/**
 * Search documents for a session's conversation. Context a producer injects as
 * a user message carries a context `form` (the runtime snapshot, the skill
 * catalog, a recalled session, a shell notice): it is not what anyone said in
 * this session, and the runtime snapshot alone would match dates and zones in
 * nearly every session. The owner's own words, including reminder prompts,
 * carry no form.
 */
export function edgeSearchDocuments(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventSearchDocument[] {
  // Build from every event (surface folding follows seq references), then
  // drop the injected contexts' documents.
  const contexts = new Set(events.filter(event => event.type === 'user/message'
    && event.data.source.kind !== 'user' && 'form' in event.data.source && event.data.source.form !== undefined)
    .map(event => event.seq))
  return buildSessionEventSearchDocuments(sessionId, events).filter(document => !contexts.has(document.seq))
}

const MAX_SEARCH_SESSIONS = 32
const MAX_SEARCH_EVENTS_PER_SESSION = 512
const MAX_SEARCH_STORED_BYTES_PER_SESSION = 256 * 1_024
const SNIPPET_MAX_CODE_POINTS = 240
/** Stored bytes one cold `readEvent` reads for its target, and for each side's neighbors. */
export const READ_EVENT_MAX_STORED_BYTES = 4 * 1_024 * 1_024
/**
 * Events and stored characters a cold session may hold for `traceEvent`,
 * which scans the whole log for the events citing its target: the upstream
 * helper takes the complete log, so a larger one is refused instead of loaded.
 */
export const TRACE_EVENT_MAX_EVENTS = 10_000
export const TRACE_EVENT_MAX_STORED_CHARACTERS = 8 * 1_024 * 1_024
/**
 * Stored sessions `traceSession` may list. Upstream traces lineage from a
 * listing of the whole corpus (the session table has no parent index), so
 * an instance with more sessions is refused instead of listed.
 */
export const TRACE_SESSION_MAX_SESSIONS = 2_000

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

  /**
   * Bounded newest-first candidate records without enumerating the corpus.
   * Every collection step stops at the candidate budget before it iterates, so
   * per-request work never grows with the live registry or the stored corpus.
   */
  private boundedCandidates(persistence: DurableObjectSessionPersistence): SessionRecord[] {
    const records = new Map<SessionId, SessionRecord>()
    for (const session of this.ctx.sessions.list()) {
      if (records.size >= MAX_SEARCH_SESSIONS) break
      records.set(session.id, {
        header: structuredClone(session.header) as SessionHeader,
        live: true,
        persisted: persistence.readSessionHeader(session.id) !== undefined,
      })
    }
    for (const summary of persistence.readRecentSessionSummaries(MAX_SEARCH_SESSIONS)) {
      if (records.size >= MAX_SEARCH_SESSIONS) break
      if (records.has(summary.meta.id)) continue
      records.set(summary.meta.id, { header: summary.meta, live: false, persisted: true })
    }
    return [...records.values()]
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
      } catch (error) {
        // Cancellation must reject the whole search; only a corrupt or
        // concurrently-deleted log is skipped without failing other candidates.
        if (signal?.aborted) throw error
        continue
      }
      if (events === undefined) continue
      const documents = filterSessionEventDocuments(
        edgeSearchDocuments(record.header.id, events),
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
      edgeSearchDocuments(request.sessionId, events),
      materializeSessionEventResultFilters(this.searchFilters(request.filters ?? [], query)),
    )
    return {
      items: documents.slice(-limit).map(document => hitOf(document, query)),
      session,
    }
  }

  /**
   * With an `id` clause (every model-tool authorization check has one), read
   * those sessions' headers by id instead of listing the whole corpus.
   */
  override async filterSessions(filters: readonly SessionResultFilter[], signal?: AbortSignal): Promise<SessionRecord[]> {
    const ids = filters.find(filter => filter.kind === 'id')
    const persistence = this.edgePersistence()
    if (ids === undefined || persistence === undefined) return super.filterSessions(filters, signal)
    signal?.throwIfAborted()
    const owned = materializeSessionResultFilters(filters)
    const records: SessionRecord[] = []
    for (const id of new Set(ids.values)) {
      const live = this.ctx.sessions.get(id)
      const stored = persistence.readSessionHeader(id) ?? persistence.readBlankSession(id)
      if (live !== undefined) {
        records.push({ header: structuredClone(live.header) as SessionHeader, live: true, persisted: stored !== undefined, formatStatus: 'current' })
      } else if (stored !== undefined) {
        records.push({ header: stored, live: false, persisted: true })
      }
    }
    records.sort((left, right) => right.header.createdAt - left.header.createdAt || (left.header.id < right.header.id ? -1 : 1))
    return filterSessionResults(records, owned)
  }

  /** Cold titles come from the summary row the log writer maintains, not from a log read. */
  override async readTitleSnapshots(sessionIds: readonly SessionId[], signal?: AbortSignal): Promise<SessionTitleObservationResult[]> {
    const persistence = this.edgePersistence()
    if (persistence === undefined) return super.readTitleSnapshots(sessionIds, signal)
    const unique = [...new Set(sessionIds)]
    const live = unique.filter(id => this.ctx.sessions.get(id) !== undefined)
    const fromLive = new Map((live.length === 0 ? [] : await super.readTitleSnapshots(live, signal)).map(result => [result.sessionId, result]))
    signal?.throwIfAborted()
    return unique.map((sessionId): SessionTitleObservationResult => {
      const observed = fromLive.get(sessionId)
      if (observed !== undefined) return observed
      const summary = persistence.readSessionSummary(sessionId)
      const blank = summary === undefined ? persistence.readBlankSession(sessionId) : undefined
      if (summary === undefined && blank === undefined) {
        return { sessionId, status: 'rejected', reason: new SessionQueryError(`session "${sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND') }
      }
      const title = summary?.titleEvent === undefined ? undefined : foldSessionTitle([summary.titleEvent])
      return { sessionId, status: 'fulfilled', value: { session: summary?.meta ?? blank!, ...title === undefined ? {} : { title } } }
    })
  }

  /**
   * A cold session's event is read with its neighbors in bounded pages, not
   * by loading the whole log: the target within {@link READ_EVENT_MAX_STORED_BYTES},
   * and each side's neighbors within the same budget, dropped when they pass it.
   */
  override async readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow> {
    const persistence = this.edgePersistence()
    if (persistence === undefined || this.ctx.sessions.get(request.sessionId) !== undefined) {
      return super.readEvent(request, signal)
    }
    const before = readWindow('before', request.before)
    const after = readWindow('after', request.after)
    const { sessionId, seq } = request
    const handle = await persistence.open(sessionId, 'read', signal === undefined ? undefined : { signal })
    const header = structuredClone(handle.header) as SessionHeader
    const inheritedEventCount = handle.inheritedEventCount
    await handle.close()
    const preflight = { preflight: true }
    const target = await persistence.readEventPage(sessionId, seq, 1, READ_EVENT_MAX_STORED_BYTES, signal, preflight)
    const event = target.events[0]
    if (event === undefined || event.seq !== seq) {
      throw target.hasMore
        ? new SessionQueryError(`event ${String(seq)} of session "${sessionId}" is over the ${String(READ_EVENT_MAX_STORED_BYTES)}-byte read limit`, 'SESSION_QUERY_PERSISTENCE_FAILED')
        : new SessionQueryError(`session "${sessionId}" has no event at seq ${String(seq)}`, 'SESSION_QUERY_EVENT_NOT_FOUND')
    }
    const startSeq = Math.max(0, seq - before)
    const preceding = before === 0
      ? []
      : (await persistence.readEventPage(sessionId, startSeq, seq - startSeq, READ_EVENT_MAX_STORED_BYTES, signal, preflight)).events
    // Neighbors that pass the budget are left out rather than read whole.
    const leading = preceding.length === seq - startSeq ? preceding : []
    const following = after === 0
      ? []
      : (await persistence.readEventPage(sessionId, seq + 1, after, READ_EVENT_MAX_STORED_BYTES, signal, preflight)).events
    const events = [...leading, event, ...following].map(snapshotSessionEvent)
    return {
      session: header,
      inheritedEventCount,
      target: events[leading.length]!,
      events,
      startSeq: events[0]!.seq,
      endSeq: events.at(-1)!.seq,
    }
  }

  /**
   * A cold log over {@link TRACE_EVENT_MAX_EVENTS} events (from the summary
   * row) or {@link TRACE_EVENT_MAX_STORED_CHARACTERS} stored characters (one
   * aggregate over at most that many rows) is refused before it is loaded.
   */
  override async traceEvent(request: SessionEventTraceRequest, signal?: AbortSignal): Promise<SessionEventTraceObservation> {
    const persistence = this.edgePersistence()
    if (persistence !== undefined && this.ctx.sessions.get(request.sessionId) === undefined) {
      const refuse = (size: string): never => {
        throw new SessionQueryError(
          `session "${request.sessionId}" is over the trace limit of ${String(TRACE_EVENT_MAX_EVENTS)} events and ${String(TRACE_EVENT_MAX_STORED_CHARACTERS)} stored characters (${size}); read the event instead`,
          'SESSION_QUERY_PERSISTENCE_FAILED',
        )
      }
      const lastSeq = persistence.readSessionSummary(request.sessionId)?.lastSeq
      if (lastSeq !== undefined && lastSeq + 1 > TRACE_EVENT_MAX_EVENTS) refuse(`${String(lastSeq + 1)} events`)
      const characters = persistence.storedEventCharacters(request.sessionId)
      if (characters > TRACE_EVENT_MAX_STORED_CHARACTERS) refuse(`${String(characters)} characters`)
    }
    return super.traceEvent(request, signal)
  }

  /** Lineage over the whole corpus, refused before listing past {@link TRACE_SESSION_MAX_SESSIONS}. */
  override async traceSession(sessionId: SessionId, signal?: AbortSignal): ReturnType<SessionQueryEngine['traceSession']> {
    const persistence = this.edgePersistence()
    if (persistence !== undefined && persistence.sessionCountUpTo(TRACE_SESSION_MAX_SESSIONS) > TRACE_SESSION_MAX_SESSIONS) {
      throw new SessionQueryError(
        `this instance stores more than ${String(TRACE_SESSION_MAX_SESSIONS)} sessions, over the lineage trace limit`,
        'SESSION_QUERY_PERSISTENCE_FAILED',
      )
    }
    return super.traceSession(sessionId, signal)
  }

  /**
   * Lineage without the cap, for the owner's session log export, which must
   * include every descendant however many sessions the instance stores.
   */
  traceSessionForExport(sessionId: SessionId, signal?: AbortSignal): ReturnType<SessionQueryEngine['traceSession']> {
    return super.traceSession(sessionId, signal)
  }

  private searchFilters(
    metadata: readonly SessionEventResultFilter[],
    query: string,
  ): SessionEventResultFilter[] {
    return query === '' ? [...metadata] : [...metadata, { kind: 'text', text: query }]
  }
}

/** Upstream's window validation, with its error code. */
function readWindow(name: string, value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isInteger(value) || value < 0 || value > SESSION_QUERY_READ_WINDOW_MAX) {
    throw new SessionQueryError(`${name} must be an integer between 0 and ${String(SESSION_QUERY_READ_WINDOW_MAX)}`, 'SESSION_QUERY_INVALID_WINDOW')
  }
  return value
}

export default EdgeSessionQuery
