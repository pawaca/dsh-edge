/**
 * Keep upstream's turn outline out of the persisted projection cache.
 *
 * `SessionProjectionCache` stores every projection row of a session in one
 * record of its `session_projcache` storage unit, and the storage domain loads
 * every record of that unit into memory each time the Durable Object starts,
 * which happens after every idle eviction. The turn outline is the only row
 * that grows with the session (100 to 400 bytes per turn), so persisting it
 * would make every start load and validate more as history accumulates, and a
 * long session's record could reach the 2 MB Durable Object value limit and
 * stop the other rows from saving. The Edge never serves the outline from the
 * cache, so the stored record leaves it out: a loaded session folds it from
 * its event log, as upstream's restore does for a missing row.
 *
 * The bound runs in the Edge storage backend (`recordBounds`), the seam every
 * write of the unit passes through.
 */

/** Upstream's projection cache storage unit and its record table. */
export const PROJECTION_CACHE_UNIT = 'session_projcache'
const PROJECTION_CACHE_TABLE = 'sessions'

const TURN_OUTLINE_KEY = 'turnOutline'

/** The `recordBounds` entry for {@link PROJECTION_CACHE_UNIT}: store each session record without its turn outline. */
export function boundProjectionCacheRecord(table: string, record: unknown): unknown {
  if (table !== PROJECTION_CACHE_TABLE || typeof record !== 'object' || record === null) return record
  const { rows } = record as { rows?: unknown }
  if (typeof rows !== 'object' || rows === null || !(TURN_OUTLINE_KEY in rows)) return record
  const { [TURN_OUTLINE_KEY]: _omitted, ...stored } = rows as Record<string, unknown>
  return { ...record, rows: stored }
}
