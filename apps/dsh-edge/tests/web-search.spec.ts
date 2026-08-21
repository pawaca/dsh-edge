import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import EdgeCredentialProvider from '../src/edge-credentials.ts'
import { installEdgeWebSearch } from '../src/web-search.ts'

describe('dsh-edge Web Search composition', () => {
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
      await ctx.plugin(EdgeCredentialProvider, { readDeepSeekApiKey: () => 'search-key' })
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
