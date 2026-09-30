import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { EdgeSettings, SETTINGS_DOCUMENT_KEY, edgeSettings } from '../src/edge-settings.ts'
import { DEEPSEEK_SETTINGS_NAMESPACE, mountDeepSeekProvider } from '../src/edge-llm-settings.ts'

function memoryStorage(): DurableObjectStorage {
  const store = new Map<string, unknown>()
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
  } as unknown as DurableObjectStorage
}

async function mounted(storage = memoryStorage()) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(EdgeSettings, { storage })
  await mountDeepSeekProvider(ctx, { baseURL: 'https://api.deepseek.com/anthropic', maxTokens: 4096 })
  return ctx
}

describe('DeepSeek provider settings', () => {
  it('serves the namespace the Models page reads for the DeepSeek row', async () => {
    const ctx = await mounted()
    // The Models page renders a provider only when its declared namespace is described,
    // and shows the DeepSeek fields only for upstream's `llm-deepseek` entry id.
    const [declared] = ctx.llm.listConfigurableProviders()
    expect(declared).toMatchObject({ provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] })
    const descriptor = edgeSettings(ctx).describe().find(entry => entry.ns === DEEPSEEK_SETTINGS_NAMESPACE)
    expect(descriptor?.base).toEqual({ baseURL: 'https://api.deepseek.com/anthropic', maxTokens: 4096 })
    expect(descriptor?.value).toMatchObject({ baseURL: 'https://api.deepseek.com/anthropic', maxTokens: 4096, apiKeyEnv: 'DEEPSEEK_API_KEY' })
  })

  it('applies a saved change to the running provider without a restart', async () => {
    const storage = memoryStorage()
    const ctx = await mounted(storage)
    const before = await ctx.llm.listModels('deepseek-official')
    const settings = edgeSettings(ctx)
    const descriptor = settings.describe().find(entry => entry.ns === DEEPSEEK_SETTINGS_NAMESPACE)
    if (descriptor === undefined) throw new Error('DeepSeek settings namespace is not registered')
    const { models } = descriptor.value as { models: { id: string }[] }
    await settings.update(DEEPSEEK_SETTINGS_NAMESPACE, { models: [{ ...models[0], id: 'edge-renamed-model' }] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(before.map(model => model.id)).not.toContain('edge-renamed-model')
    expect((await ctx.llm.listModels('deepseek-official')).map(model => model.id)).toEqual(['edge-renamed-model'])

    // The saved section survives a restart and mounts the provider with it.
    await ctx.fiber.dispose()
    const restarted = await mounted(storage)
    expect((await restarted.llm.listModels('deepseek-official')).map(model => model.id)).toEqual(['edge-renamed-model'])
  })

  it('keeps the Models edits 0.18 stored under the same section', async () => {
    const storage = memoryStorage()
    await storage.put(SETTINGS_DOCUMENT_KEY, { 'llm-deepseek': { reasoningEffort: 'low', maxTokens: 2048 } })
    const ctx = await mounted(storage)
    expect(edgeSettings(ctx).describe().find(entry => entry.ns === DEEPSEEK_SETTINGS_NAMESPACE)?.value)
      .toMatchObject({ baseURL: 'https://api.deepseek.com/anthropic', reasoningEffort: 'low', maxTokens: 2048 })
  })

  it('refuses a change the provider schema rejects and keeps the running values', async () => {
    const ctx = await mounted()
    const settings = edgeSettings(ctx)
    await expect(settings.update(DEEPSEEK_SETTINGS_NAMESPACE, { maxTokens: 0 })).rejects.toThrow()
    expect(settings.describe().find(entry => entry.ns === DEEPSEEK_SETTINGS_NAMESPACE)?.value).toMatchObject({ maxTokens: 4096 })
  })
})
