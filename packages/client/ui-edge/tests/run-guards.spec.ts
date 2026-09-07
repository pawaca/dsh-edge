import { describe, expect, it, vi } from 'vitest'
import { installRunGuards } from '../src/client/run-guards.ts'

describe('observed Remote run controls', () => {
  it('uses the observed turn, preserves ordinary admission, and restores Remote descriptors', async () => {
    const ordinary = vi.fn(async () => ({ ok: true }))
    const remote = {} as Record<string, (...args: any[]) => any>
    Object.defineProperty(remote, 'follow', { configurable: true, get: () => async function* () {
      yield { type: 'snapshot', records: [{ type: 'event', event: { type: 'turn/start', seq: 7 } }] }
    } })
    for (const key of ['prompt', 'cancel', 'updateQueue']) Object.defineProperty(remote, key, { configurable: true, get: () => ordinary })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ result: { ok: true, value: { accepted: true } } }))
    const dispose = installRunGuards(remote, fetch)
    for await (const _ of remote.follow!({ address: { sessionId: 's' } })) { /* consume canonical history */ }
    await remote.prompt!({ sessionId: 's', mode: 'queue' })
    expect(ordinary).toHaveBeenCalledOnce()
    await remote.cancel!({ sessionId: 's' })
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-dsh-edge-turn-seq')).toBe('7')
    dispose()
    expect(remote.cancel).toBe(ordinary)
  })
})
