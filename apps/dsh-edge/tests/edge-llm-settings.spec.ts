import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { EdgeSettings, SETTINGS_DOCUMENT_KEY, edgeSettings } from '../src/edge-settings.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEEPSEEK_SETTINGS_NAMESPACE, PI_AI_SETTINGS_NAMESPACE, explained, mountDeepSeekProvider, mountPiAiProvider, requireNonCredentialHeaders, requireProviderBaseURL } from '../src/edge-llm-settings.ts'

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
      for await (const chunk of explained((async function* () { yield* chunks })())) out.push(chunk)
      return out
    }
    const [notFound] = await collect([finish({ message: 'DeepSeek Messages request failed (404)', code: 'HTTP_404', status: 404 })])
    const failure = (notFound as unknown as { reason: { kind: string, failure: { message: string, code: string, status: number } } }).reason
    expect(failure.kind).toBe('error')
    // The provider's own failure stays first; the hint is conditional, since a gateway may 404 for a resource.
    expect(failure.failure.message.startsWith('DeepSeek Messages request failed (404). If this began after upgrading from dsh-edge 0.18')).toBe(true)
    expect(failure.failure.message).toContain('may not serve the Messages API')
    // A gateway may carry its credential in any URL component; the persisted message names none of them.
    expect(failure.failure.message).not.toContain('gateway.example.com')
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

  it('applies a saved retry policy to the running provider route', async () => {
    const ctx = await mounted()
    expect(ctx.llm.providerRetryPolicy('deepseek-official')).toMatchObject({ mode: 'normal', maxRetries: 5 })
    // The provider re-registers its route on the Loader's volatile-update notice.
    await edgeSettings(ctx).update(DEEPSEEK_SETTINGS_NAMESPACE, { retryPolicy: { mode: 'normal', maxRetries: 2 } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.llm.providerRetryPolicy('deepseek-official')).toMatchObject({ mode: 'normal', maxRetries: 2 })
  })
})

async function mountedWithRoutes(storage = memoryStorage()) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(EdgeSettings, { storage })
  await mountPiAiProvider(ctx)
  return ctx
}

const MOCK_ROUTE = {
  displayName: 'Mock OpenAI',
  api: 'openai-completions',
  baseURL: 'https://llm.example.com/v1',
  apiKeyEnv: 'MOCK_OPENAI_API_KEY',
  models: [{ id: 'mock-gpt', name: 'Mock GPT' }],
}

describe('third-party provider routes', () => {
  it('starts with no route and lists upstream\'s configurable providers on the Models page', async () => {
    const ctx = await mountedWithRoutes()
    expect(edgeSettings(ctx).describe().find(entry => entry.ns === PI_AI_SETTINGS_NAMESPACE)?.value).toEqual({ providers: {} })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual([])
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.length).toBeGreaterThan(10)
    expect(directory.every(entry => entry.settingsNs === PI_AI_SETTINGS_NAMESPACE)).toBe(true)
    expect(directory.map(entry => entry.provider)).toContain('openrouter')
  })

  it('serves a saved route without a restart and keeps it after one', async () => {
    const storage = memoryStorage()
    const ctx = await mountedWithRoutes(storage)
    await edgeSettings(ctx).update(PI_AI_SETTINGS_NAMESPACE, { providers: { 'mock-openai': MOCK_ROUTE } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['mock-openai'])
    expect((await ctx.llm.listModels('mock-openai')).map(model => model.id)).toEqual(['mock-gpt'])

    await ctx.fiber.dispose()
    const restarted = await mountedWithRoutes(storage)
    expect(restarted.llm.listProviders().map(provider => provider.id)).toEqual(['mock-openai'])
  })

  it('refuses a Base URL with credentials and a route the provider cannot serve', async () => {
    const ctx = await mountedWithRoutes()
    const settings = edgeSettings(ctx)
    await expect(settings.update(PI_AI_SETTINGS_NAMESPACE, { providers: { 'mock-openai': { ...MOCK_ROUTE, baseURL: 'https://user:secret@llm.example.com/v1' } } }))
      .rejects.toThrow('without credentials')
    // pi-ai has no catalog for this id, so without a Base URL it cannot serve it.
    await expect(settings.update(PI_AI_SETTINGS_NAMESPACE, { providers: { 'mock-openai': { api: 'openai-completions', models: [{ id: 'mock-gpt' }] } } }))
      .rejects.toThrow()
    expect(settings.describe().find(entry => entry.ns === PI_AI_SETTINGS_NAMESPACE)?.value).toEqual({ providers: {} })
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('keeps credentials out of route headers', async () => {
    const ctx = await mountedWithRoutes()
    const settings = edgeSettings(ctx)
    for (const name of ['Authorization', 'x-api-key', 'cf-aig-authorization', 'X-Auth-Token', 'Cookie', 'api-secret']) {
      await expect(settings.update(PI_AI_SETTINGS_NAMESPACE, { providers: { 'mock-openai': { ...MOCK_ROUTE, headers: { [name]: 'Bearer sk-secret' } } } }))
        .rejects.toThrow('looks like a credential')
    }
    expect(settings.describe().find(entry => entry.ns === PI_AI_SETTINGS_NAMESPACE)?.value).toEqual({ providers: {} })
    // Ordinary routing headers stay allowed.
    await settings.update(PI_AI_SETTINGS_NAMESPACE, { providers: { 'mock-openai': { ...MOCK_ROUTE, headers: { 'HTTP-Referer': 'https://edge.example.com', 'X-Title': 'dsh-edge' } } } })
    expect(() => { requireNonCredentialHeaders('a', undefined) }).not.toThrow()
  })

  it('accepts only HTTP(S) Base URLs without credentials', () => {
    expect(() => { requireProviderBaseURL('a', 'https://openrouter.ai/api/v1') }).not.toThrow()
    expect(() => { requireProviderBaseURL('a', 'http://gateway.internal:8080/v1') }).not.toThrow()
    expect(() => { requireProviderBaseURL('a', 'ftp://example.com') }).toThrow('without credentials')
    expect(() => { requireProviderBaseURL('a', 'https://k:@example.com') }).toThrow('without credentials')
    // A signed gateway URL keeps its token in the query or fragment.
    expect(() => { requireProviderBaseURL('a', 'https://gateway.example/v1?token=secret') }).toThrow('a query, or a fragment')
    expect(() => { requireProviderBaseURL('a', 'https://gateway.example/v1#secret') }).toThrow('a query, or a fragment')
    expect(() => { requireProviderBaseURL('a', 'https://gateway.example/v1?') }).toThrow('a query, or a fragment')
    expect(() => { requireProviderBaseURL('a', 'not a url') }).toThrow('valid HTTP(S) URL')
  })
})
