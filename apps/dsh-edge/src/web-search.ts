/** Upstream DeepSeek Web Search composition for the Cloudflare runtime. */

import type { Context } from '@deepseek-ai/cordis'
import * as TimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as DeepSeekWebSearch from '@deepseek-ai/dsh-web-search-deepseek'

/** Validate the credential-bearing Anthropic-compatible search endpoint. */
export function resolveEdgeSearchBaseURL(raw?: string): string {
  const value = raw ?? DeepSeekWebSearch.DEEPSEEK_DEFAULT_BASE_URL
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('DEEPSEEK_SEARCH_BASE_URL must be a valid HTTP(S) URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('DEEPSEEK_SEARCH_BASE_URL must be a valid HTTP(S) URL.')
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error('DEEPSEEK_SEARCH_BASE_URL must be an HTTP(S) URL without credentials.')
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('DEEPSEEK_SEARCH_BASE_URL must not contain a query or fragment.')
  }
  return parsed.href.replace(/\/+$/u, '')
}

/** Mount the shipped upstream search seam, provider, and search-only model tool. */
export async function installEdgeWebSearch(ctx: Context, rawBaseURL?: string): Promise<void> {
  await ctx.plugin(WebRuntime, { searchProvider: DeepSeekWebSearch.DEEPSEEK_PROVIDER_ID })
  await ctx.plugin(DeepSeekWebSearch, {
    baseURL: resolveEdgeSearchBaseURL(rawBaseURL),
  })
  await ctx.plugin(TimeoutPolicy)
  await ctx.plugin(ToolWeb, { search: true, fetch: false })
}
