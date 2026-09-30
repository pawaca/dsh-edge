import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { EdgeSettings, SETTINGS_DOCUMENT_KEY, edgeSettings } from '../src/edge-settings.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEEPSEEK_SETTINGS_NAMESPACE, explained, mountDeepSeekProvider } from '../src/edge-llm-settings.ts'

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

  it('moves a 0.18 Models page Base URL off the old OpenAI-compatible root', async () => {
    const storage = memoryStorage()
    await storage.put(SETTINGS_DOCUMENT_KEY, { 'llm-deepseek': { baseURL: 'https://api.deepseek.com', maxTokens: 2048 } })
    const ctx = await mounted(storage)
    const section = edgeSettings(ctx).describe().find(entry => entry.ns === DEEPSEEK_SETTINGS_NAMESPACE)
    expect(section?.user).toEqual({ baseURL: 'https://api.deepseek.com/anthropic', maxTokens: 2048 })
    expect((await storage.get(SETTINGS_DOCUMENT_KEY) as Record<string, unknown>)['llm-deepseek']).toEqual({ baseURL: 'https://api.deepseek.com/anthropic', maxTokens: 2048 })
  })

  it('keeps a gateway Base URL and explains a 404 from it', async () => {
    const storage = memoryStorage()
    await storage.put(SETTINGS_DOCUMENT_KEY, { 'llm-deepseek': { baseURL: 'https://gateway.example.com/v1' } })
    const ctx = await mounted(storage)
    expect(edgeSettings(ctx).describe().find(entry => entry.ns === DEEPSEEK_SETTINGS_NAMESPACE)?.value)
      .toMatchObject({ baseURL: 'https://gateway.example.com/v1' })
    const finish = (failure: Record<string, unknown>) => ({ type: 'finish', reason: { kind: 'error', failure } }) as unknown as StreamChunk
    const collect = async (chunks: StreamChunk[]) => {
      const out: StreamChunk[] = []
      for await (const chunk of explained((async function* () { yield* chunks })(), () => 'https://gateway.example.com/v1')) out.push(chunk)
      return out
    }
    const [notFound] = await collect([finish({ message: 'DeepSeek Messages request failed (404)', code: 'HTTP_404', status: 404 })])
    const failure = (notFound as unknown as { reason: { kind: string, failure: { message: string, code: string, status: number } } }).reason
    expect(failure.kind).toBe('error')
    expect(failure.failure.message).toContain('https://gateway.example.com/v1 does not serve the Messages API')
    expect(failure.failure.message).toContain('https://api.deepseek.com/anthropic')
    expect(failure.failure).toMatchObject({ code: 'HTTP_404', status: 404 })
    // Other outcomes pass through unchanged.
    const other = [
      { type: 'text-delta', index: 0, text: 'hi' } as unknown as StreamChunk,
      finish({ message: 'rate limited', code: 'RATE_LIMIT', status: 429 }),
    ]
    expect(await collect(other)).toEqual(other)
  })

  it('refuses a change the provider schema rejects and keeps the running values', async () => {
    const ctx = await mounted()
    const settings = edgeSettings(ctx)
    await expect(settings.update(DEEPSEEK_SETTINGS_NAMESPACE, { maxTokens: 0 })).rejects.toThrow()
    expect(settings.describe().find(entry => entry.ns === DEEPSEEK_SETTINGS_NAMESPACE)?.value).toMatchObject({ maxTokens: 4096 })
  })
})
