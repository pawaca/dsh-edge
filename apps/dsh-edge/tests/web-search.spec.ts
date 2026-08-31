import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import EdgeCredentialProvider from '../src/edge-credentials.ts'
import { installEdgeWebSearch } from '../src/web-search.ts'

describe('dsh-edge Web Search composition', () => {
  it('fetches a public HTML page and converts it to Markdown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`<!doctype html>
      <main><h1>Worker Fetch</h1><p>Rendered <strong>inside</strong> Cloudflare.</p>
      <script>globalThis.fixtureMustNotAppear = true</script></main>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })))

    const ctx = new Context()
    try {
      const storage = { get: () => Promise.resolve(undefined), put: () => Promise.resolve(), delete: () => Promise.resolve(true) } as unknown as DurableObjectStorage
      await ctx.plugin(EdgeCredentialProvider, { storage, readDeepSeekApiKey: () => 'search-key' })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await installEdgeWebSearch(ctx, 'https://search.test/anthropic/v1')

      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('public-html'),
        name: 'web_fetch',
        arguments: { url: 'https://fixture.example/page' },
      })
      expect(result).toMatchObject({ isError: false })
      const rendered = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      expect(rendered).toContain('# Worker Fetch')
      expect(rendered).toContain('Rendered **inside** Cloudflare.')
      expect(rendered).not.toContain('fixtureMustNotAppear')
    } finally {
      await ctx.fiber.dispose()
      vi.unstubAllGlobals()
    }
  })

  it.each([
    'http://127.0.0.1:8787/private',
    'http://2130706433/private',
    'http://[::1]/private',
    'http://metadata.internal/private',
    'http://service.localhost/private',
  ])('blocks private target %s before network access', async (url) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    const ctx = new Context()
    try {
      const storage = { get: () => Promise.resolve(undefined), put: () => Promise.resolve(), delete: () => Promise.resolve(true) } as unknown as DurableObjectStorage
      await ctx.plugin(EdgeCredentialProvider, { storage, readDeepSeekApiKey: () => 'search-key' })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await installEdgeWebSearch(ctx, 'https://search.test/anthropic/v1')

      await expect(ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`blocked-${url}`),
        name: 'web_fetch',
        arguments: { url },
      })).resolves.toMatchObject({
        isError: true,
        error: { info: { code: 'WEB_BLOCKED_URL' } },
      })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('enforces the upstream tool timeout against a stalled provider', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal === undefined || signal === null) {
          reject(new Error('missing search abort signal'))
          return
        }
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('search aborted'))
        }, { once: true })
      })
    )))

    const ctx = new Context()
    try {
      const storage = { get: () => Promise.resolve(undefined), put: () => Promise.resolve(), delete: () => Promise.resolve(true) } as unknown as DurableObjectStorage
      await ctx.plugin(EdgeCredentialProvider, { storage, readDeepSeekApiKey: () => 'search-key' })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await installEdgeWebSearch(ctx, 'https://search.test/anthropic/v1')

      const result = ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('stalled-search'),
        name: 'web_search',
        arguments: { queries: ['timeout contract'] },
      })
      const resultAssertion = expect(result).resolves.toMatchObject({
        isError: true,
        error: { info: { code: 'TOOL_TIMEOUT' } },
      })
      await vi.advanceTimersByTimeAsync(30_000)
      await resultAssertion
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
