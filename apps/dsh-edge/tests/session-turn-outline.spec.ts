import { serialize } from 'node:v8'
import { describe, expect, it, vi } from 'vitest'
import * as SessionTurnOutline from '@deepseek-ai/dsh-session-turn-outline'
import { boundProjectionCacheRows, boundProjectionCacheWrites, PROJECTION_CACHE_BUDGET_BYTES } from '../src/edge-projection-cache.ts'

/** The 2 MB key-plus-value limit of a SQLite-backed Durable Object's KV API. */
const DO_VALUE_LIMIT_BYTES = 2 * 1024 * 1024

interface OutlineDefinition {
  init: () => unknown
  apply: (state: unknown, event: { type: string; seq: number; data: unknown }) => unknown
}

function outlineDefinition(): OutlineDefinition {
  let definition: OutlineDefinition | undefined
  SessionTurnOutline.apply({ sessionProjections: { register: (unit: OutlineDefinition) => { definition = unit } } } as never)
  if (definition === undefined) throw new Error('turn outline did not register its projection')
  return definition
}

/** Fold `turns` turns of long CJK prompts and replies, which upstream clips to full-length previews. */
function worstCaseOutline(turns: number): unknown {
  const { init, apply } = outlineDefinition()
  const prompt = '请帮我检查这个会话里所有失败的命令并总结原因'.repeat(20)
  const reply = '已检查完毕，失败的原因主要是容器启动超时和依赖缺失，下面逐条说明'.repeat(20)
  let state = init()
  let seq = 0
  for (let turn = 1; turn <= turns; turn++) {
    state = apply(state, { type: 'turn/start', seq: ++seq, data: { turn } })
    state = apply(state, { type: 'user/message', seq: ++seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] } })
    state = apply(state, { type: 'assistant/message', seq: ++seq, data: { message: { content: [{ type: 'text', text: reply }] } } })
    state = apply(state, { type: 'turn/end', seq: ++seq, data: { turn } })
  }
  return state
}

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

  it('leaves only the outline out of a cached record that would outgrow the Durable Object value', async () => {
    const row = (val: unknown) => ({ ver: 1, seq: 1, val })
    const small = { turnOutline: row(worstCaseOutline(10)), sessionStats: row({ turns: 10 }) }
    expect(boundProjectionCacheRows(small)).toBe(small)
    // Thousands of turns stay whole while the record fits the budget.
    const fits = { turnOutline: row(worstCaseOutline(1_500)), sessionStats: row({ turns: 1_500 }) }
    expect(boundProjectionCacheRows(fits)).toBe(fits)
    const huge = { turnOutline: row(worstCaseOutline(6_000)), sessionStats: row({ turns: 6_000 }), goal: row({ status: 'active' }) }
    const bounded = boundProjectionCacheRows(huge)
    expect(Object.keys(bounded).sort()).toEqual(['goal', 'sessionStats'])
    expect(serialize(bounded).length).toBeLessThan(PROJECTION_CACHE_BUDGET_BYTES)
    // Every write of the upstream cache goes through the bound.
    const stored: unknown[] = []
    const cache = { put: vi.fn(async (_id: unknown, _identity: unknown, rows: unknown) => { stored.push(rows) }) }
    boundProjectionCacheWrites(cache)
    await cache.put('session-huge', {}, huge)
    expect(Object.keys(stored[0] as object).sort()).toEqual(['goal', 'sessionStats'])
  })
})
