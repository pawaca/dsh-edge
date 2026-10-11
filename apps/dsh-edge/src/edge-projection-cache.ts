/**
 * Keep upstream's per-session projection cache value within the Durable
 * Object limit.
 *
 * `SessionProjectionCache` stores every projection row of a session in one
 * record, and a SQLite-backed Durable Object accepts at most 2 MB per key and
 * value. The turn outline is the only row that grows with the session (about
 * 400 bytes per turn), so past several thousand turns the whole record would
 * stop saving and every cached projection (goal, todos, stats, title) would go
 * stale. Over the budget, the outline row is left out instead: the other rows
 * stay current, cold reads serve no outline, and an activated session refolds
 * the outline from its event log, which upstream's restore does for a missing row.
 */

/** Serialized-size budget for one cached record, below the 2 MB Durable Object limit. */
export const PROJECTION_CACHE_BUDGET_BYTES = 1.5 * 1024 * 1024

const TURN_OUTLINE_KEY = 'turnOutline'
/** Below this many outline entries the record cannot approach the budget, so it is not measured. */
const MEASURE_FROM_TURNS = 1_000

/** The cached rows to store: unchanged, or without the turn outline when the record would exceed the budget. */
export function boundProjectionCacheRows(
  rows: Readonly<Record<string, unknown>>,
  budgetBytes = PROJECTION_CACHE_BUDGET_BYTES,
): Readonly<Record<string, unknown>> {
  const outline = rows[TURN_OUTLINE_KEY] as { val?: { turns?: readonly unknown[] } } | undefined
  if ((outline?.val?.turns?.length ?? 0) < MEASURE_FROM_TURNS) return rows
  // Two bytes per UTF-16 code unit bounds what storage's structured clone writes for these strings.
  if (JSON.stringify(rows).length * 2 <= budgetBytes) return rows
  const { [TURN_OUTLINE_KEY]: _omitted, ...bounded } = rows
  return bounded
}

interface ProjectionCacheWriter {
  put(id: unknown, identity: unknown, rows: Readonly<Record<string, unknown>>): Promise<void>
}

/** Route every cache write (soft flushes and cold-read write-backs) through {@link boundProjectionCacheRows}. */
export function boundProjectionCacheWrites(cache: ProjectionCacheWriter): void {
  const put = cache.put.bind(cache)
  cache.put = (id, identity, rows) => put(id, identity, boundProjectionCacheRows(rows))
}
