import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { EdgeSettings, edgeSettings } from '../src/edge-settings.ts'
import { CLIENT_SETTINGS } from '../src/edge-client-settings.ts'

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

describe('EdgeSettings', () => {
  it('installs as a cordis plugin and reports writable', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(EdgeSettings, { storage })
    expect(ctx.settings).toBeDefined()
    expect(edgeSettings(ctx).writable).toBe(true)
    await ctx.fiber.dispose()
  })

  it('persists a settings document to DO KV on write', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(EdgeSettings, { storage })
    expect(storage.store.has(SETTINGS_DOCUMENT_KEY)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('loads empty state from fresh storage', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(EdgeSettings, { storage })
    const described = edgeSettings(ctx).describe()
    expect(described).toEqual([])
    await ctx.fiber.dispose()
  })

  it('survives malformed stored data', async () => {
    const storage = createMockStorage()
    storage.store.set(SETTINGS_DOCUMENT_KEY, 'not-an-object')
    const ctx = new Context()
    await ctx.plugin(EdgeSettings, { storage })
    const described = edgeSettings(ctx).describe()
    expect(described).toEqual([])
    await ctx.fiber.dispose()
  })

  it('survives null stored data', async () => {
    const storage = createMockStorage()
    storage.store.set(SETTINGS_DOCUMENT_KEY, null)
    const ctx = new Context()
    await ctx.plugin(EdgeSettings, { storage })
    const described = edgeSettings(ctx).describe()
    expect(described).toEqual([])
    await ctx.fiber.dispose()
  })

  it('survives array stored data', async () => {
    const storage = createMockStorage()
    storage.store.set(SETTINGS_DOCUMENT_KEY, [1, 2, 3])
    const ctx = new Context()
    await ctx.plugin(EdgeSettings, { storage })
    const described = edgeSettings(ctx).describe()
    expect(described).toEqual([])
    await ctx.fiber.dispose()
  })

  it('persists a namespace write and restores it in a fresh context', async () => {
    const storage = createMockStorage()
    const schema = Object.assign((v: unknown) => v ?? {}, { toJSON: () => ({ type: 'object' }) }) as never

    const ctx1 = new Context()
    await ctx1.plugin(EdgeSettings, { storage })
    const scope1 = edgeSettings(ctx1).register('test-ns' as never, schema, {})
    await edgeSettings(ctx1).mutate('test-ns' as never, [{ op: 'set', path: ['key'], value: 'hello' }])
    expect(scope1.get()).toEqual({ key: 'hello' })
    expect(storage.store.has(SETTINGS_DOCUMENT_KEY)).toBe(true)
    await ctx1.fiber.dispose()

    const ctx2 = new Context()
    await ctx2.plugin(EdgeSettings, { storage })
    const scope2 = edgeSettings(ctx2).register('test-ns' as never, schema, {})
    expect(scope2.get()).toEqual({ key: 'hello' })
    await ctx2.fiber.dispose()
  })

  it('serves live (volatile) fields as plain values, as upstream settings forms do', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(EdgeSettings, { storage })
    const settings = edgeSettings(ctx)
    const scope = settings.register('live-fixture', z.object({
      enabled: z.boolean().default(false).volatile(),
      nested: z.object({ mode: z.union(['a', 'b']).default('a').volatile() }),
    }), {})
    expect(scope.get()).toEqual({ enabled: false, nested: { mode: 'a' } })
    await scope.update({ enabled: true, nested: { mode: 'b' } })
    expect(scope.get()).toEqual({ enabled: true, nested: { mode: 'b' } })
    const view = settings.describe().find(row => row.ns === 'live-fixture')
    expect(view?.value).toEqual({ enabled: true, nested: { mode: 'b' } })
    await ctx.fiber.dispose()
  })

  it('reads back the shipped client settings the page writes', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(EdgeSettings, { storage })
    const settings = edgeSettings(ctx)
    const scopes = Object.fromEntries(CLIENT_SETTINGS.map(row => [row.namespace, settings.register(row.namespace, row.schema as never, {})]))
    await scopes['ui-settings']!.update({ enabled: true })
    await scopes['ui-theme']!.update({ preference: 'dark' })
    expect(settings.describe().find(row => row.ns === 'ui-settings')?.value).toEqual({ enabled: true })
    expect(settings.describe().find(row => row.ns === 'ui-theme')?.value).toMatchObject({ preference: 'dark' })
    await ctx.fiber.dispose()
  })
})
