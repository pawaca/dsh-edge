import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DurableObjectSessionPersistence } from '../src/do-session-persistence.ts'
import { EdgeSessionStore } from '../src/session-store.ts'

describe('Edge session feedback', () => {
  it('acknowledges feedback only once saved, and saves a retried entry instead of duplicating it', async () => {
    const events: { seq: number; type: string; data: unknown }[] = [{ seq: 1, type: 'turn/start', data: {} }]
    const saved = new Set<number>([1])
    const live = { snapshotEvents: () => events }
    let failSave = true
    const flush = vi.fn(async () => {
      if (failSave) throw new Error('injected storage failure')
      for (const event of events) saved.add(event.seq)
    })
    const persistence = Object.assign(Object.create(DurableObjectSessionPersistence.prototype) as object, {
      eventRowsFrom: (_id: unknown, fromSeq: number) => [...saved].filter(seq => seq >= fromSeq).map(seq => ({ seq })),
    })
    const store = Object.assign(Object.create(EdgeSessionStore.prototype) as object, {
      context: { sessions: { get: () => live, flush } },
      services: async () => ({ persistence }),
    }) as unknown as EdgeSessionStore
    const id = SessionId('session-feedback')
    const record = vi.fn(async (entry: { text: string; category?: string }) => {
      events.push({ seq: events.length + 1, type: 'feedback/record', data: { text: entry.text.trim(), ...(entry.category === undefined ? {} : { category: entry.category }) } })
      return 'appended'
    })
    const entry = { text: ' slow replies ', category: 'service-stability' }

    // The save fails: the client is told so rather than told it was recorded.
    await expect(store.recordSessionFeedback(id, entry, () => record(entry), 'recorded')).rejects.toThrow('injected storage failure')
    expect(record).toHaveBeenCalledTimes(1)
    // The client retries: the pending identical event is saved, not appended again.
    failSave = false
    await expect(store.recordSessionFeedback(id, entry, () => record(entry), 'recorded')).resolves.toBe('recorded')
    expect(record).toHaveBeenCalledTimes(1)
    expect(events.filter(event => event.type === 'feedback/record')).toHaveLength(1)
    expect(saved.has(2)).toBe(true)
    // Once saved, the same remark submitted again is new feedback.
    await expect(store.recordSessionFeedback(id, entry, () => record(entry), 'recorded')).resolves.toBe('appended')
    // So is a different remark while one is pending.
    failSave = true
    await expect(store.recordSessionFeedback(id, { text: 'other' }, () => record({ text: 'other' }), 'recorded')).rejects.toThrow()
    failSave = false
    await expect(store.recordSessionFeedback(id, entry, () => record(entry), 'recorded')).resolves.toBe('appended')
    expect(record).toHaveBeenCalledTimes(4)
  })
})
