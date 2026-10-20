/**
 * Live settings for the upstream plugins whose configuration cards the Web
 * client ships: the agent loop (`dsh-client-ui-settings-agent-loop`) and
 * web search (`dsh-client-ui-settings-web-search`), whose card edits three
 * namespaces: which provider serves search and fetch (`web`), the Messages
 * search provider (`web-search-deepseek`), and the Search and Fetch API
 * providers (`web-deepseek-api`).
 *
 * Upstream serves each card's namespace from the plugin's Loader entry and
 * commits a saved live value into the running plugin. The Edge mounts these
 * plugins directly, so it registers the namespaces itself under the upstream
 * entry ids and commits saved values the same way as the DeepSeek provider's
 * Models page settings (see edge-llm-settings.ts).
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as DeepSeekWebApi from '@deepseek-ai/dsh-web-deepseek-api'
import * as DeepSeekWebSearch from '@deepseek-ai/dsh-web-search-deepseek'
import { commitVolatile, requireProviderBaseURL } from './edge-llm-settings.ts'
import { edgeSettings } from './edge-settings.ts'

/** Upstream's Loader entry id for the agent loop, and the namespace its card edits. */
export const AGENT_LOOP_SETTINGS_NAMESPACE = 'agent-loop'
/** Upstream's Loader entry id for DeepSeek web search, and the namespace its card edits. */
export const WEB_SEARCH_SETTINGS_NAMESPACE = 'web-search-deepseek'
/** The web seam's entry id, and the namespace that selects which provider serves search and fetch. */
export const WEB_SETTINGS_NAMESPACE = 'web'
/** Upstream's Loader entry id for the DeepSeek Search and Fetch API providers, and the namespace its card edits. */
export const WEB_API_SETTINGS_NAMESPACE = 'web-deepseek-api'
/** The credential the Models page stores the DeepSeek key under; the Search and Fetch APIs use the same key. */
export const DEEPSEEK_API_KEY_NAME = 'DEEPSEEK_API_KEY'
/** Key names that belong to DeepSeek or another Edge feature, as for provider routes. */
const RESERVED_WEB_CREDENTIAL_NAME = /^(DEEPSEEK_|MCP_TOKEN_|DSH_EDGE_)/u

/**
 * The agent loop's owner-editable field. Its `agents` list is how the Edge
 * composes the loop, not an owner setting, so it stays out of the namespace.
 */
const AgentLoopSettings = z.object({
  maxParallelToolCalls: z.number().step(1).min(1).default(10).volatile(),
})

/** Mount the agent loop on the `agent-loop` namespace its settings card edits. */
export async function mountAgentLoop(ctx: Context): Promise<Fiber> {
  const scope = edgeSettings(ctx).register(AGENT_LOOP_SETTINGS_NAMESPACE, AgentLoopSettings, { discardInvalidSection: true })
  const input = (settings: unknown) => ({ ...settings as object, agents: [] })
  const fiber = ctx.plugin(AgentLoop, input(scope.get()) as never)
  await fiber.await()
  scope.watch(next => { commitVolatile(fiber, AgentLoop.Config(input(next) as never)) })
  return fiber
}

/** Upstream's Loader entry id for the subagent runtime, and the namespace the Subagent card's limits edit. */
export const SUBAGENT_SETTINGS_NAMESPACE = 'subagent'

/**
 * Mount the subagent runtime on the `subagent` namespace: delegation depth
 * (maxDepth, default 1) and resident continuable children (maxActiveSubagents,
 * default 8), both committed live as upstream's Loader entry does.
 */
export async function mountSubagentRuntime(
  ctx: Context,
  SubagentRuntime: { Config: (value: unknown) => unknown } & Parameters<Context['plugin']>[0],
): Promise<Fiber> {
  const scope = edgeSettings(ctx).register(SUBAGENT_SETTINGS_NAMESPACE, SubagentRuntime.Config as never, { discardInvalidSection: true })
  const fiber = ctx.plugin(SubagentRuntime, { ...scope.get() as object } as never)
  await fiber.await()
  scope.watch(next => { commitVolatile(fiber, SubagentRuntime.Config(next)) })
  return fiber
}

/** Upstream's Loader entry id for subagent model selection, and the namespace the Subagent card's models section edits. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = 'subagent-model-selection-settings'

/**
 * Mount upstream's subagent model-selection setting on the namespace the
 * Subagent card's models section edits, committed live as upstream's Loader
 * entry does. Turning selection on with no allowed model is refused on save:
 * upstream reads the setting as each new session is composed and would fail
 * that session instead.
 */
export async function mountSubagentModelSelection(
  ctx: Context,
  SubagentModelSelectionConfig: { Config: (value: unknown) => unknown } & Parameters<Context['plugin']>[0],
): Promise<Fiber> {
  const scope = edgeSettings(ctx).register(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, SubagentModelSelectionConfig.Config as never, {
    validate: value => {
      const { enabled, allowedModels } = value as { enabled: boolean, allowedModels: readonly unknown[] }
      if (enabled && allowedModels.length === 0) throw new Error('Choose at least one model before turning subagent model selection on.')
    },
    discardInvalidSection: true,
  })
  const fiber = ctx.plugin(SubagentModelSelectionConfig, { ...scope.get() as object } as never)
  await fiber.await()
  scope.watch(next => { commitVolatile(fiber, SubagentModelSelectionConfig.Config(next)) })
  return fiber
}

/**
 * Mount DeepSeek web search on the `web-search-deepseek` namespace its settings
 * card edits. The deployment's endpoint is the base, and an endpoint saved on
 * the card must pass the same check as `DEEPSEEK_SEARCH_BASE_URL`, so the
 * credential-bearing request can never go to a URL that embeds credentials or
 * carries a query.
 */
export async function mountDeepSeekWebSearch(
  ctx: Context,
  baseURL: string,
  /** Throws on an endpoint the deployment variable would refuse; returns it without a trailing slash. */
  validateBaseURL: (value: string) => string,
): Promise<Fiber> {
  const scope = edgeSettings(ctx).register(WEB_SEARCH_SETTINGS_NAMESPACE, DeepSeekWebSearch.Config, {
    base: { baseURL } as never,
    validate: value => { validateBaseURL((value as { baseURL: string }).baseURL) },
    // An endpoint the 0.18 card saved may fail today's check; it must not stop the runtime.
    discardInvalidSection: true,
  })
  // The provider gets the endpoint in the form the deployment variable takes
  // (no trailing slash), whatever spelling the card saved.
  const input = (settings: unknown) => {
    const value = settings as { baseURL: string }
    return { ...value, baseURL: validateBaseURL(value.baseURL) }
  }
  const fiber = ctx.plugin(DeepSeekWebSearch, input(scope.get()) as never)
  await fiber.await()
  scope.watch(next => { commitVolatile(fiber, DeepSeekWebSearch.Config(input(next) as never)) })
  return fiber
}

/** Search and fetch providers the Edge mounts, by the ids the `web` selection takes. */
export interface WebProviderIds {
  readonly search: readonly [messages: string, api: string]
  readonly fetch: readonly [http: string, api: string]
}

/**
 * Refuse a selection of a provider the Edge does not mount, so a saved value
 * can never leave search or fetch without a provider.
 */
export function requireWebSelection(value: { searchProvider?: unknown, fetchProvider?: unknown }, providers: WebProviderIds): void {
  if (typeof value.searchProvider === 'string' && !providers.search.includes(value.searchProvider)) {
    throw new Error(`Web search can use ${providers.search.join(' or ')}, not "${value.searchProvider}".`)
  }
  if (typeof value.fetchProvider === 'string' && !providers.fetch.includes(value.fetchProvider)) {
    throw new Error(`Web fetch can use ${providers.fetch.join(' or ')}, not "${value.fetchProvider}".`)
  }
}

/**
 * Refuse a Search and Fetch API section that would send a credential somewhere
 * it should not go or keep one in the settings document, which is stored in
 * plain text: the API base must be an HTTP(S) URL without credentials, a query,
 * or a fragment; no literal key; and the key name must be the DeepSeek key or
 * one of the provider's own, never another feature's credential.
 * @returns the API base without a trailing slash, as the provider appends `/search` and `/fetch`.
 */
export function requireWebApiSection(value: { baseURL: string, apiKey?: unknown, apiKeyEnv: string }): string {
  requireProviderBaseURL('DeepSeek Search and Fetch API', value.baseURL)
  if (typeof value.apiKey === 'string' && value.apiKey.length > 0) {
    throw new Error('Store the API key through the Models page or the web search card: a key in this section would be kept in the settings in plain text.')
  }
  if (value.apiKeyEnv !== DEEPSEEK_API_KEY_NAME && RESERVED_WEB_CREDENTIAL_NAME.test(value.apiKeyEnv)) {
    throw new Error(`The Search and Fetch APIs may not use the credential "${value.apiKeyEnv}", which belongs to another Edge feature; use ${DEEPSEEK_API_KEY_NAME} or a key name of its own.`)
  }
  return value.baseURL.replace(/\/+$/u, '')
}

/**
 * Mount the web seam on the `web` namespace, so the web search card's switch
 * can choose the Messages providers or the Search and Fetch APIs for the next
 * operation. `base` is the selection the deployment ships.
 */
export async function mountWebSelection(
  ctx: Context,
  base: { searchProvider: string, fetchProvider: string },
  providers: WebProviderIds,
): Promise<Fiber> {
  const scope = edgeSettings(ctx).register(WEB_SETTINGS_NAMESPACE, WebRuntime.Config, {
    base: base as never,
    validate: value => { requireWebSelection(value as { searchProvider?: unknown, fetchProvider?: unknown }, providers) },
    // A section that no longer passes must not stop the runtime; the shipped selection applies.
    discardInvalidSection: true,
  })
  const fiber = ctx.plugin(WebRuntime, { ...scope.get() as object } as never)
  await fiber.await()
  scope.watch(next => { commitVolatile(fiber, WebRuntime.Config(next as never)) })
  return fiber
}

/**
 * Mount the DeepSeek Search and Fetch API providers on the `web-deepseek-api`
 * namespace their card edits. They are always registered and selected only
 * through `web`; they reuse the DeepSeek key the Models page stores, resolved
 * for each operation through the credential seam and never kept in settings.
 * The account sign-in route needs a service the Edge does not mount, so every
 * operation authenticates with the key.
 */
export async function mountDeepSeekWebApi(ctx: Context): Promise<Fiber> {
  const scope = edgeSettings(ctx).register(WEB_API_SETTINGS_NAMESPACE, DeepSeekWebApi.Config, {
    validate: value => { requireWebApiSection(value as { baseURL: string, apiKey?: unknown, apiKeyEnv: string }) },
    discardInvalidSection: true,
  })
  const input = (settings: unknown) => {
    const value = settings as { baseURL: string, apiKey?: unknown, apiKeyEnv: string }
    return { ...value, baseURL: requireWebApiSection(value) }
  }
  const fiber = ctx.plugin(DeepSeekWebApi, input(scope.get()) as never)
  await fiber.await()
  scope.watch(next => { commitVolatile(fiber, DeepSeekWebApi.Config(input(next) as never)) })
  return fiber
}
