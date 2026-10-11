import { serialize } from 'node:v8'
import { describe, expect, it } from 'vitest'
import { worstCaseOutline } from './fixtures/turn-outline.ts'
import { boundProjectionCacheRows, PROJECTION_CACHE_BUDGET_BYTES } from '../src/edge-projection-cache.ts'

/** The 2 MB key-plus-value limit of a SQLite-backed Durable Object's KV API. */
const DO_VALUE_LIMIT_BYTES = 2 * 1024 * 1024

describe('upstream turn outline on the Edge', () => {
  it('keeps each turn bounded, so the cached projection value fits the Durable Object limit for thousands of turns', () => {
    const turns = 4_000
    const state = worstCaseOutline(turns)
    const entries = (state as { turns: { prompt: string; response: string }[] }).turns
    expect(entries).toHaveLength(turns)
    expect(entries.every(entry => entry.prompt.length <= 50 && entry.response.length <= 120)).toBe(true)
    // Structured clone is how Durable Object storage serializes the value.
    const bytes = serialize(state).length
    expect(bytes / turns).toBeLessThan(400)
    expect(bytes).toBeLessThan(DO_VALUE_LIMIT_BYTES)
  })

  it('leaves only the outline out of a cached record that would outgrow the Durable Object value', () => {
    const row = (val: unknown) => ({ ver: 1, seq: 1, val })
    const small = { turnOutline: row(worstCaseOutline(10)), sessionStats: row({ turns: 10 }) }
    expect(boundProjectionCacheRows(small)).toBe(small)
    // Thousands of turns stay whole while the record fits the budget.
    const fits = { turnOutline: row(worstCaseOutline(1_500)), sessionStats: row({ turns: 1_500 }) }
    expect(boundProjectionCacheRows(fits)).toBe(fits)
    const huge = { turnOutline: row(worstCaseOutline(6_000)), sessionStats: row({ turns: 6_000 }), goal: row({ status: 'active' }) }
    // A short outline is left out too when other rows already fill the record.
    const crowded = { turnOutline: row(worstCaseOutline(20)), todos: row({ items: ['待办事项'.repeat(200_000)] }) }
    expect(Object.keys(boundProjectionCacheRows(crowded))).toEqual(['todos'])
    const bounded = boundProjectionCacheRows(huge)
    expect(Object.keys(bounded).sort()).toEqual(['goal', 'sessionStats'])
    expect(serialize(bounded).length).toBeLessThan(PROJECTION_CACHE_BUDGET_BYTES)
  })
})
