import { serialize } from 'node:v8'
import { describe, expect, it } from 'vitest'
import { worstCaseOutline } from './fixtures/turn-outline.ts'

describe('upstream turn outline on the Edge', () => {
  it('keeps each turn bounded, so a loaded session holds and sends a few hundred bytes per turn', () => {
    // Worst case: long CJK prompts and replies, clipped by upstream to full-length previews.
    const turns = 4_000
    const state = worstCaseOutline(turns)
    const entries = (state as { turns: { prompt: string; response: string }[] }).turns
    expect(entries).toHaveLength(turns)
    expect(entries.every(entry => entry.prompt.length <= 50 && entry.response.length <= 120)).toBe(true)
    expect(serialize(state).length / turns).toBeLessThan(400)
  })
})
