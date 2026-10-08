/**
 * Live settings for the upstream plugins whose configuration cards the Web
 * client ships: the agent loop (`dsh-client-ui-settings-agent-loop`) and
 * DeepSeek web search (`dsh-client-ui-settings-web-search`).
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
import * as DeepSeekWebSearch from '@deepseek-ai/dsh-web-search-deepseek'
import { commitVolatile } from './edge-llm-settings.ts'
import { edgeSettings } from './edge-settings.ts'

/** Upstream's Loader entry id for the agent loop, and the namespace its card edits. */
export const AGENT_LOOP_SETTINGS_NAMESPACE = 'agent-loop'
/** Upstream's Loader entry id for DeepSeek web search, and the namespace its card edits. */
export const WEB_SEARCH_SETTINGS_NAMESPACE = 'web-search-deepseek'

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
