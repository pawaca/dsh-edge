/// <reference types="node" />
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import * as HttpWebFetch from '@deepseek-ai/dsh-web-fetch-http'
import * as DeepSeekWebApi from '@deepseek-ai/dsh-web-deepseek-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EdgeSettings, edgeSettings } from '../src/edge-settings.ts'
import {
  DEEPSEEK_API_KEY_NAME,
  WEB_API_SETTINGS_NAMESPACE,
  WEB_SETTINGS_NAMESPACE,
  mountDeepSeekWebApi,
  mountWebSelection,
  requireWebApiSection,
  requireWebSelection,
  type WebProviderIds,
} from '../src/edge-plugin-settings.ts'

const PROVIDERS: WebProviderIds = {
  search: ['deepseek-official', DeepSeekWebApi.DEEPSEEK_SEARCH_API_PROVIDER_ID],
  fetch: [HttpWebFetch.LOCAL_FETCH_PROVIDER_ID, DeepSeekWebApi.DEEPSEEK_FETCH_API_PROVIDER_ID],
}

function memoryStorage(): DurableObjectStorage {
  const store = new Map<string, unknown>()
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
  } as unknown as DurableObjectStorage
}

interface Seen { method: string, url: string, authorization: string | undefined, body: unknown }

/** A stand-in for the Search and Fetch API: records each request and answers as `respond` says. */
async function apiServer(respond: (seen: Seen) => { status: number, body: string, headers?: Record<string, string> }) {
  const seen: Seen[] = []
  const server = createServer((request: IncomingMessage, response) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { text += chunk })
    request.on('end', () => {
      const entry: Seen = {
        method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization,
        body: text === '' ? undefined : JSON.parse(text),
      }
      seen.push(entry)
      const answer = respond(entry)
      response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers })
      response.end(answer.body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/tools`
  return { seen, base, close: () => new Promise<void>(resolve => server.close(() => { resolve() })) }
}

/** The web seam as the Edge mounts it, with fetch on the Worker (`http`) until a setting moves it to the API. */
async function mounted(storage = memoryStorage()) {
  const ctx = new Context()
  await ctx.plugin(EdgeSettings, { storage })
  await mountWebSelection(ctx, { searchProvider: PROVIDERS.search[0], fetchProvider: PROVIDERS.fetch[0] }, PROVIDERS)
  await ctx.plugin(HttpWebFetch)
  await mountDeepSeekWebApi(ctx)
  return ctx
}

afterEach(() => { vi.unstubAllEnvs() })

describe('web selection and API validation', () => {
  it('takes only the providers the Edge mounts', () => {
    expect(() => requireWebSelection({ searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' }, PROVIDERS)).not.toThrow()
    expect(() => requireWebSelection({ searchProvider: 'deepseek-official', fetchProvider: 'http' }, PROVIDERS)).not.toThrow()
    expect(() => requireWebSelection({ searchProvider: 'exa' }, PROVIDERS)).toThrow('not "exa"')
    expect(() => requireWebSelection({ fetchProvider: 'browser' }, PROVIDERS)).toThrow('not "browser"')
  })

  it('keeps the API base, the key, and the key name where credentials belong', () => {
    const ok = { baseURL: 'https://api.deepseek.com/v1/tools/', apiKeyEnv: DEEPSEEK_API_KEY_NAME }
    expect(requireWebApiSection(ok)).toBe('https://api.deepseek.com/v1/tools')
    expect(requireWebApiSection({ ...ok, apiKeyEnv: 'WEB_API_OWN_KEY' })).toBe('https://api.deepseek.com/v1/tools')
    for (const baseURL of ['ftp://example.com/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?token=1', 'https://example.com/v1#x', 'not a url']) {
      expect(() => requireWebApiSection({ ...ok, baseURL }), baseURL).toThrow()
    }
    expect(() => requireWebApiSection({ ...ok, apiKey: 'sk-literal' })).toThrow('plain text')
    for (const apiKeyEnv of ['DSH_EDGE_ACCESS_KEY', 'MCP_TOKEN_github', 'DEEPSEEK_OTHER']) {
      expect(() => requireWebApiSection({ ...ok, apiKeyEnv }), apiKeyEnv).toThrow('belongs to another Edge feature')
    }
  })

  it('refuses a saved section that would break either rule', async () => {
    vi.stubEnv(DEEPSEEK_API_KEY_NAME, 'sk-test')
    const ctx = await mounted()
    const settings = edgeSettings(ctx)
    await expect(settings.update(WEB_SETTINGS_NAMESPACE, { fetchProvider: 'browser' })).rejects.toThrow('not "browser"')
    await expect(settings.update(WEB_API_SETTINGS_NAMESPACE, { baseURL: 'https://u:p@example.com/v1' })).rejects.toThrow()
    await expect(settings.update(WEB_API_SETTINGS_NAMESPACE, { apiKey: 'sk-literal' })).rejects.toThrow('plain text')
    await expect(settings.update(WEB_API_SETTINGS_NAMESPACE, { apiKeyEnv: 'DSH_EDGE_ACCESS_KEY' })).rejects.toThrow('another Edge feature')
    await ctx.fiber.dispose()
  })
})

describe('the Search and Fetch APIs', () => {
  it('serves the next fetch from the API once the selection moves, with the DeepSeek key and without the Worker reading the page', async () => {
    vi.stubEnv(DEEPSEEK_API_KEY_NAME, 'sk-test')
    const api = await apiServer(() => ({ status: 200, body: JSON.stringify({ content: '# Page\n\nfrom the API\n' }) }))
    const storage = memoryStorage()
    try {
      const ctx = await mounted(storage)
      const settings = edgeSettings(ctx)
      // The shipped selection fetches from the Worker, whose own fetch refuses a loopback target.
      await expect(ctx.web.fetch({ url: 'http://127.0.0.1:9/page' })).rejects.toBeInstanceOf(Error)
      expect(api.seen).toEqual([])

      await settings.update(WEB_API_SETTINGS_NAMESPACE, { baseURL: api.base })
      await settings.update(WEB_SETTINGS_NAMESPACE, { fetchProvider: 'deepseek-fetch-api' })
      const result = await ctx.web.fetch({ url: 'https://example.com/page' })
      expect(result).toMatchObject({ url: 'https://example.com/page', statusCode: 200, body: { kind: 'text', content: '# Page\n\nfrom the API\n' } })
      expect(api.seen).toHaveLength(1)
      expect(api.seen[0]).toMatchObject({
        method: 'POST', url: '/v1/tools/fetch', authorization: 'Bearer sk-test', body: { url: 'https://example.com/page' },
      })

      // The saved selection survives a restart, and turning the switch off restores the shipped one.
      await ctx.fiber.dispose()
      const restarted = await mounted(storage)
      await restarted.web.fetch({ url: 'https://example.com/again' })
      expect(api.seen).toHaveLength(2)
      await edgeSettings(restarted).update(WEB_SETTINGS_NAMESPACE, { fetchProvider: 'http' })
      await expect(restarted.web.fetch({ url: 'http://127.0.0.1:9/page' })).rejects.toBeDefined()
      expect(api.seen).toHaveLength(2)
      await restarted.fiber.dispose()
    } finally { await api.close() }
  })

  it('searches through the API with the question bounds the provider sends', async () => {
    vi.stubEnv(DEEPSEEK_API_KEY_NAME, 'sk-test')
    const api = await apiServer(() => ({
      status: 200,
      body: JSON.stringify({ results: [{ title: 'A', url: 'https://example.com/a', snippet: 'about a', date: null }] }),
    }))
    try {
      const ctx = new Context()
      await ctx.plugin(EdgeSettings, { storage: memoryStorage() })
      await mountWebSelection(ctx, { searchProvider: PROVIDERS.search[1], fetchProvider: PROVIDERS.fetch[1] }, PROVIDERS)
      await mountDeepSeekWebApi(ctx)
      await edgeSettings(ctx).update(WEB_API_SETTINGS_NAMESPACE, { baseURL: api.base, count: 3 })
      const result = await ctx.web.search({ query: 'dsh edge', maxResults: 2 })
      expect(result.sources).toEqual([expect.objectContaining({ title: 'A', url: 'https://example.com/a' })])
      expect(api.seen[0]).toMatchObject({ url: '/v1/tools/search', authorization: 'Bearer sk-test', body: { query: 'dsh edge', count: 2 } })
      await ctx.fiber.dispose()
    } finally { await api.close() }
  })

  it('fails with guidance when there is no key, and refuses a redirect before following it', async () => {
    const api = await apiServer(() => ({ status: 302, body: '', headers: { location: 'http://169.254.169.254/latest' } }))
    try {
      const ctx = new Context()
      await ctx.plugin(EdgeSettings, { storage: memoryStorage() })
      await mountWebSelection(ctx, { searchProvider: PROVIDERS.search[1], fetchProvider: PROVIDERS.fetch[1] }, PROVIDERS)
      await mountDeepSeekWebApi(ctx)
      await edgeSettings(ctx).update(WEB_API_SETTINGS_NAMESPACE, { baseURL: api.base })
      const missing = await ctx.web.fetch({ url: 'https://example.com/' }).catch((error: unknown) => error as { code: string, message: string })
      expect(missing).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      expect((missing as { message: string }).message).toContain(DEEPSEEK_API_KEY_NAME)
      expect(api.seen).toEqual([])

      vi.stubEnv(DEEPSEEK_API_KEY_NAME, 'sk-test')
      await expect(ctx.web.fetch({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      // Only the API was contacted; the redirect's target never was.
      expect(api.seen.map(entry => entry.url)).toEqual(['/v1/tools/fetch'])
      await ctx.fiber.dispose()
    } finally { await api.close() }
  })
})
