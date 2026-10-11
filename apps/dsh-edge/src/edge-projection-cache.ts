/**
 * Keep upstream's per-session projection cache record within the Durable
 * Object limit.
 *
 * `SessionProjectionCache` stores every projection row of a session in one
 * record of its `session_projcache` storage unit, and a SQLite-backed Durable
 * Object accepts at most 2 MB per key and value. The turn outline is the only
 * row that grows with the session (about 400 bytes per turn), so past several
 * thousand turns the whole record would stop saving and every cached
 * projection (goal, todos, stats, title) would go stale. Over the budget, the
 * outline row is left out of the stored record instead: the other rows stay
 * current, cold reads serve no outline, and an activated session refolds the
 * outline from its event log, as upstream's restore does for a missing row.
 *
 * The bound runs in the Edge storage backend (`recordBounds`), the seam every
 * write of the unit passes through.
 */

/** Upstream's projection cache storage unit and its record table. */
export const PROJECTION_CACHE_UNIT = 'session_projcache'
const PROJECTION_CACHE_TABLE = 'sessions'

/** Serialized-size budget for one cached record, below the 2 MB Durable Object limit. */
export const PROJECTION_CACHE_BUDGET_BYTES = 1.5 * 1024 * 1024

const TURN_OUTLINE_KEY = 'turnOutline'

/** The cached rows to store: unchanged, or without the turn outline when the record would exceed the budget. */
export function boundProjectionCacheRows(
  rows: Readonly<Record<string, unknown>>,
  budgetBytes = PROJECTION_CACHE_BUDGET_BYTES,
): Readonly<Record<string, unknown>> {
  if (!(TURN_OUTLINE_KEY in rows)) return rows
  // The whole record is measured: other rows (subagent catalogs, todos) grow
  // too, so a short outline can still be what pushes it over. Writes happen
  // per turn or per 64 events, so serializing a typical few-KB record is cheap.
  // Two bytes per UTF-16 code unit bounds what storage's structured clone writes for these strings.
  if (JSON.stringify(rows).length * 2 <= budgetBytes) return rows
  const { [TURN_OUTLINE_KEY]: _omitted, ...bounded } = rows
  return bounded
}

/** The `recordBounds` entry for {@link PROJECTION_CACHE_UNIT}: bound each session record's rows. */
export function boundProjectionCacheRecord(table: string, record: unknown): unknown {
  if (table !== PROJECTION_CACHE_TABLE || typeof record !== 'object' || record === null) return record
  const { rows } = record as { rows?: unknown }
  if (typeof rows !== 'object' || rows === null) return record
  const bounded = boundProjectionCacheRows(rows as Record<string, unknown>)
  return bounded === rows ? record : { ...record, rows: bounded }
}
