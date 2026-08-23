import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { DurableObjectSettingsProvider } from '../src/do-settings-provider.ts'

const SETTINGS_DOCUMENT_KEY = 'dsh-edge:settings-document'

function createMockStorage(): DurableObjectStorage & { readonly store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
    delete: (key: string) => { store.delete(key); return Promise.resolve(true) },
  } as unknown as DurableObjectStorage & { readonly store: Map<string, unknown> }
}

describe('DurableObjectSettingsProvider', () => {
  it('installs as a cordis plugin and reports writable', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(DurableObjectSettingsProvider, { storage })
    expect(ctx.settings).toBeDefined()
    expect(ctx.settings.writable).toBe(true)
    await ctx.fiber.dispose()
  })

  it('persists a settings document to DO KV on write', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(DurableObjectSettingsProvider, { storage })
    expect(storage.store.has(SETTINGS_DOCUMENT_KEY)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('loads empty state from fresh storage', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(DurableObjectSettingsProvider, { storage })
    const described = ctx.settings.describe()
    expect(described).toEqual([])
    await ctx.fiber.dispose()
  })

  it('survives malformed stored data', async () => {
    const storage = createMockStorage()
    storage.store.set(SETTINGS_DOCUMENT_KEY, 'not-an-object')
    const ctx = new Context()
    await ctx.plugin(DurableObjectSettingsProvider, { storage })
    const described = ctx.settings.describe()
    expect(described).toEqual([])
    await ctx.fiber.dispose()
  })

  it('survives null stored data', async () => {
    const storage = createMockStorage()
    storage.store.set(SETTINGS_DOCUMENT_KEY, null)
    const ctx = new Context()
    await ctx.plugin(DurableObjectSettingsProvider, { storage })
    const described = ctx.settings.describe()
    expect(described).toEqual([])
    await ctx.fiber.dispose()
  })

  it('survives array stored data', async () => {
    const storage = createMockStorage()
    storage.store.set(SETTINGS_DOCUMENT_KEY, [1, 2, 3])
    const ctx = new Context()
    await ctx.plugin(DurableObjectSettingsProvider, { storage })
    const described = ctx.settings.describe()
    expect(described).toEqual([])
    await ctx.fiber.dispose()
  })

  it('persists a namespace write and restores it in a fresh context', async () => {
    const storage = createMockStorage()
    const schema = Object.assign((v: unknown) => v ?? {}, { toJSON: () => ({ type: 'object' }) }) as never

    const ctx1 = new Context()
    await ctx1.plugin(DurableObjectSettingsProvider, { storage })
    const scope1 = ctx1.settings.register('test-ns' as never, schema, {})
    await ctx1.settings.mutate('test-ns' as never, [{ op: 'set', path: ['key'], value: 'hello' }])
    expect(scope1.get()).toEqual({ key: 'hello' })
    expect(storage.store.has(SETTINGS_DOCUMENT_KEY)).toBe(true)
    await ctx1.fiber.dispose()

    const ctx2 = new Context()
    await ctx2.plugin(DurableObjectSettingsProvider, { storage })
    const scope2 = ctx2.settings.register('test-ns' as never, schema, {})
    expect(scope2.get()).toEqual({ key: 'hello' })
    await ctx2.fiber.dispose()
  })
})
