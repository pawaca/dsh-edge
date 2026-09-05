/** Live-preferred session query engine over the Edge Durable Object persistence. */

import type { Context } from '@deepseek-ai/cordis'
import SessionQueryEngine, {
  type SessionEventResultFilter,
  type SessionEventSearchDocument,
  type SessionEventSearchHit,
  type SessionEventSearchPage,
  type SessionEventSearchRequest,
  type SessionSearchExecContext,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

const MAX_SEARCH_SESSIONS = 32
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
 * serves; only the two full-text entry points are provider-specific. Both scan
 * the concrete `filterEvents` corpus with a literal text clause, bounded to the
 * newest sessions like the pre-existing Edge search.
 */
export class EdgeSessionQuery extends SessionQueryEngine {
  constructor(ctx: Context) {
    super(ctx)
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    const signal = exec?.signal
    signal?.throwIfAborted()
    const limit = Math.max(1, Math.floor(request.limit ?? 20))
    const query = request.query.trim()
    const filters = this.searchFilters(request.eventFilters ?? [], query)
    const sessions = await this.filterSessions(request.sessionFilters ?? [], signal)
    const items: SessionSearchHit[] = []
    for (const record of sessions.slice(0, MAX_SEARCH_SESSIONS)) {
      signal?.throwIfAborted()
      if (items.length >= limit) break
      let documents: SessionEventSearchDocument[]
      try {
        documents = await this.filterEvents(record.header.id, filters)
      } catch {
        // A corrupt or concurrently-deleted log never fails the whole search.
        continue
      }
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
    const limit = Math.max(1, Math.floor(request.limit ?? 50))
    const query = request.query.trim()
    const { session } = await this.readTitleSnapshot(request.sessionId, signal)
    const documents = await this.filterEvents(
      request.sessionId,
      this.searchFilters(request.filters ?? [], query),
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
