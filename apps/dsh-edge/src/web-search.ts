/** Upstream DeepSeek Web Search composition for the Cloudflare runtime. */

import type { Context } from '@deepseek-ai/cordis'
import * as TimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import * as DeepSeekWebApi from '@deepseek-ai/dsh-web-deepseek-api'
import * as HttpWebFetch from '@deepseek-ai/dsh-web-fetch-http'
import * as DeepSeekWebSearch from '@deepseek-ai/dsh-web-search-deepseek'
import { mountDeepSeekWebApi, mountDeepSeekWebSearch, mountWebSelection, type WebProviderIds } from './edge-plugin-settings.ts'

/** The providers the Edge mounts, by the ids the `web` selection takes. */
const WEB_PROVIDERS: WebProviderIds = {
  search: [DeepSeekWebSearch.DEEPSEEK_PROVIDER_ID, DeepSeekWebApi.DEEPSEEK_SEARCH_API_PROVIDER_ID],
  fetch: [HttpWebFetch.LOCAL_FETCH_PROVIDER_ID, DeepSeekWebApi.DEEPSEEK_FETCH_API_PROVIDER_ID],
}

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

/** Mount the shipped upstream web seam, search/fetch providers, and model tools. */
export async function installEdgeWebSearch(ctx: Context, rawBaseURL?: string): Promise<void> {
  // The shipped selection is Messages search with fetch from the Worker. The web search
  // card's switch moves the selection to the Search and Fetch APIs, where DeepSeek fetches
  // the page and the Worker does not.
  await mountWebSelection(ctx, {
    searchProvider: DeepSeekWebSearch.DEEPSEEK_PROVIDER_ID,
    fetchProvider: HttpWebFetch.LOCAL_FETCH_PROVIDER_ID,
  }, WEB_PROVIDERS)
  // Max searches, endpoint, and key are editable on the web search settings card.
  await mountDeepSeekWebSearch(ctx, resolveEdgeSearchBaseURL(rawBaseURL), resolveEdgeSearchBaseURL)
  await ctx.plugin(HttpWebFetch)
  await mountDeepSeekWebApi(ctx)
  await ctx.plugin(TimeoutPolicy)
  await ctx.plugin(ToolWeb, { search: true, fetch: true })
}
