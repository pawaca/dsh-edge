import { Context } from '@deepseek-ai/cordis'
import MessageFeedbackService, {
  type MessageFeedbackRow,
  type MessageFeedbackStore,
} from '@deepseek-ai/dsh-message-feedback'
import { describe, expect, it } from 'vitest'
import { DurableObjectMessageFeedbackStore } from '../src/do-message-feedback-store.ts'

const row: MessageFeedbackRow = {
  session: { createdAt: 1, cwd: '/workspace' },
  items: [{
    messageId: 'message-1' as MessageFeedbackRow['items'][number]['messageId'],
    rating: 'positive',
    note: 'useful',
    version: 'd7f6edc4-859e-4a80-a025-86b5e3d31dcb' as MessageFeedbackRow['items'][number]['version'],
    createdAt: 2,
    updatedAt: 2,
  }],
}

function createMockStorage(initial: Record<string, unknown> = {}): DurableObjectStorage & {
  readonly values: Map<string, unknown>
  readonly listCalls: { count: number }
} {
  const values = new Map(Object.entries(initial))
  const listCalls = { count: 0 }
  return {
    values,
    listCalls,
    get: (key: string) => Promise.resolve(values.get(key)),
    put: (key: string, value: unknown) => { values.set(key, value); return Promise.resolve() },
    list: () => { listCalls.count += 1; throw new Error('message feedback must use point reads') },
  } as unknown as DurableObjectStorage & {
    readonly values: Map<string, unknown>
    readonly listCalls: { count: number }
  }
}

describe('DurableObjectMessageFeedbackStore', () => {
  it('installs the upstream service without opening storage-domain', async () => {
    const context = new Context()
    let domainOpenCalls = 0
    context.provide('storageDomain', {
      open: () => {
        domainOpenCalls += 1
        return Promise.reject(new Error('message feedback must use the injected store'))
      },
    } as never)
    context.provide('sessionPersistence', {} as never)
    context.provide('sessions', {} as never)
    const store: MessageFeedbackStore = {
      get: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
    }

    await context.plugin(MessageFeedbackService, { maxNoteBytes: 8_192, store })
    expect(context.messageFeedback).toBeDefined()
    expect(domainOpenCalls).toBe(0)
    await context.fiber.dispose()
  })

  it('reads and writes the existing storage-domain keys without listing the unit', async () => {
    const storage = createMockStorage()
    const store = new DurableObjectMessageFeedbackStore(storage)
    await store.put('session-1', row)

    expect(storage.values.get('dsh-kv:message_feedback:__version__')).toBe(0)
    expect(await store.get('session-1')).toEqual(row)
    expect(storage.listCalls.count).toBe(0)
  })

  it('rejects malformed point-read rows', async () => {
    const storage = createMockStorage({
      'dsh-kv:message_feedback:__version__': 0,
      'dsh-kv:message_feedback:sessions:session-1': { items: 'invalid' },
    })
    const store = new DurableObjectMessageFeedbackStore(storage)

    await expect(store.get('session-1')).rejects.toMatchObject({ code: 'malformed-medium' })
    expect(storage.listCalls.count).toBe(0)
  })

  it('preserves the storage-domain version guard', async () => {
    const storage = createMockStorage({ 'dsh-kv:message_feedback:__version__': 1 })
    const store = new DurableObjectMessageFeedbackStore(storage)

    await expect(store.get('session-1')).rejects.toMatchObject({ code: 'version-mismatch' })
    expect(storage.listCalls.count).toBe(0)
  })
})
