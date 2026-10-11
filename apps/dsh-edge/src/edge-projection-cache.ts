/**
 * Keep growing, rebuildable projection rows out of the persisted projection
 * cache.
 *
 * `SessionProjectionCache` stores every projection row of a session in one
 * record of its `session_projcache` storage unit, and the storage domain loads
 * every record of that unit into memory each time the Durable Object starts,
 * which happens after every idle eviction. A row that grows with the session
 * would make every start load and validate more as history accumulates, and a
 * long session's record could reach the 2 MB Durable Object value limit and
 * stop the other rows from saving.
 *
 * Left out of the stored record, a row is folded from the session's event log
 * when the session is loaded, as upstream's restore does for a missing row. The
 * Edge never serves these rows from the cache for a session that is not loaded.
 *
 * The bound runs in the Edge storage backend (`recordBounds`), the seam every
 * write of the unit passes through.
 */

/** Upstream's projection cache storage unit and its record table. */
export const PROJECTION_CACHE_UNIT = 'session_projcache'
const PROJECTION_CACHE_TABLE = 'sessions'

/**
 * Rows that grow with the session (or hold a copy of a user message) and are
 * rebuilt from its log:
 *
 * - `contextBreakdown`: one node per message in context, about 150 bytes per
 *   turn until a compaction collapses them. In a 600-turn session it was 98% of
 *   the cached record (88 of 90 KB), rewritten on every turn and loaded on every
 *   Durable Object start. Rebuilding it measured no slower than reading it.
 * - `turnOutline`: one 100 to 400 byte entry per turn, never trimmed.
 * - `titleInput`: a full copy of the first user message (up to 64 KiB).
 *
 * The client shows the context meter from `contextPressure`, which stays
 * persisted, and treats a missing `contextBreakdown` as no breakdown detail.
 */
export const UNPERSISTED_PROJECTION_ROWS: readonly string[] = ['turnOutline', 'contextBreakdown', 'titleInput']

/** The `recordBounds` entry for {@link PROJECTION_CACHE_UNIT}: store each session record without its growing rows. */
export function boundProjectionCacheRecord(table: string, record: unknown): unknown {
  if (table !== PROJECTION_CACHE_TABLE || typeof record !== 'object' || record === null) return record
  const { rows } = record as { rows?: unknown }
  if (typeof rows !== 'object' || rows === null) return record
  const stored = Object.fromEntries(Object.entries(rows).filter(([key]) => !UNPERSISTED_PROJECTION_ROWS.includes(key)))
  return Object.keys(stored).length === Object.keys(rows).length ? record : { ...record, rows: stored }
}
