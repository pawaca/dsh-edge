/**
 * The DeepSeek provider's configuration as a live settings namespace.
 *
 * Upstream 0.2.0 providers take live (volatile) configuration from the plugin
 * Loader, and the Models page edits it through the settings namespace named by
 * the provider's Loader entry id (`llm-deepseek` in upstream compositions, the
 * section 0.18 stored the owner's Models edits under). The Edge mounts the
 * provider directly, so it registers that namespace itself, with the
 * deployment's values as `base`, names the provider's fiber as that entry, and
 * commits each saved change into the references the running provider holds, as
 * the Loader does for a volatile-only update.
 *
 * Other providers are configured as upstream does it: `dsh-llm-pi-ai` on the
 * `llm-pi-ai` namespace, one profile per provider route, edited on the same
 * Models page, with each provider's API key kept by the credentials service.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { deepEqual, updateVolatile, volatileEntries } from '@deepseek-ai/cosmokit'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as dshLlmDeepseekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as dshLlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { upgradeLegacyDeepSeekBaseURL } from './deepseek.ts'
import { edgeSettings } from './edge-settings.ts'

/** The provider route the DeepSeek API-key plugin registers. */
const DEEPSEEK_PROVIDER = 'deepseek-official'

/** Upstream's Loader entry id for the DeepSeek API-key provider, and its settings namespace. */
export const DEEPSEEK_SETTINGS_NAMESPACE = 'llm-deepseek'

/** Mount the DeepSeek API-key provider on the settings namespace the Models page edits. */
export async function mountDeepSeekProvider(ctx: Context, base: Record<string, unknown>): Promise<void> {
  const settings = edgeSettings(ctx)
  const scope = settings.register(DEEPSEEK_SETTINGS_NAMESPACE, dshLlmDeepseekApiKey.Config, { base })
  // A Base URL saved on the 0.18 Models page may be DeepSeek's old
  // OpenAI-compatible root; move it to the Messages root once, visibly.
  const saved = (settings.describe().find(entry => entry.ns === DEEPSEEK_SETTINGS_NAMESPACE)?.user as { baseURL?: unknown } | undefined)?.baseURL
  if (typeof saved === 'string' && upgradeLegacyDeepSeekBaseURL(saved) !== saved) {
    await scope.update({ baseURL: upgradeLegacyDeepSeekBaseURL(saved) })
  }
  explainMissingMessagesEndpoint(ctx)
  // The provider declares `ctx.fiber.entry?.options.id` to the Models page. Name
  // its fiber before it applies, where the Loader assigns an entry.
  const stop = ctx.on('internal/plugin', (fiber) => {
    const named = fiber as Fiber & { entry?: { options: { id: string } } }
    if (fiber.runtime?.callback === dshLlmDeepseekApiKey.apply && named.entry === undefined) {
      named.entry = { options: { id: DEEPSEEK_SETTINGS_NAMESPACE } }
    }
  })
  let fiber: Fiber
  try {
    fiber = ctx.plugin(dshLlmDeepseekApiKey, scope.get() as never)
  } finally {
    stop()
  }
  await fiber.await()
  scope.watch(next => commitVolatile(fiber, dshLlmDeepseekApiKey.Config(next as never)))
}

/** Upstream's Loader entry id for the pi-ai provider routes, and their settings namespace. */
export const PI_AI_SETTINGS_NAMESPACE = 'llm-pi-ai'

/**
 * Mount upstream's pi-ai provider routes on the namespace the Models page
 * edits. No route is configured by default. A save is refused when a route's
 * Base URL is not an HTTP(S) URL without credentials, as DEEPSEEK_BASE_URL is,
 * or when the provider itself cannot serve it (its Loader `internal/config`
 * check); a section that no longer passes is dropped on start instead of
 * failing the instance.
 */
export async function mountPiAiProvider(ctx: Context): Promise<Fiber> {
  let fiber: Fiber | undefined
  /** The routes saved before this change; none while the namespace is registering. */
  let savedRoutes = (): Record<string, unknown> => ({})
  const scope = edgeSettings(ctx).register(PI_AI_SETTINGS_NAMESPACE, dshLlmPiAi.Config as never, {
    validate: value => {
      const { providers } = value as { providers?: Record<string, { baseURL?: unknown, headers?: Record<string, unknown>, apiKeyEnv?: unknown }> }
      // A route id another adapter already serves (DeepSeek's) would make the
      // runtime refuse the whole registration, on save and after a restart.
      const ours = new Set(Object.keys(savedRoutes()))
      const taken = new Set(ctx.llm.listProviders().map(entry => entry.id).filter(id => !ours.has(id)))
      for (const [provider, profile] of Object.entries(providers ?? {})) {
        if (taken.has(provider)) throw new Error(`The provider id "${provider}" is already served by another model provider; choose a different id.`)
        if (typeof profile.baseURL === 'string') requireProviderBaseURL(provider, profile.baseURL)
        requireAllowedHeaders(provider, profile.headers)
        requireRouteCredentialName(provider, profile.apiKeyEnv)
      }
      if (fiber !== undefined) {
        // The provider's own check, as the Loader runs it: on the running
        // fiber, which its `internal/config` listener compares against.
        const candidate = structuredClone(value)
        fiber.ctx.waterfall(fiber.ctx.fiber, 'internal/config', candidate, () => candidate)
      }
    },
    discardInvalidSection: true,
  })
  savedRoutes = () => (scope.get() as { providers?: Record<string, unknown> }).providers ?? {}
  const stop = ctx.on('internal/plugin', (candidate) => {
    const named = candidate as Fiber & { entry?: { options: { id: string } } }
    if (candidate.runtime?.callback === dshLlmPiAi.apply && named.entry === undefined) {
      named.entry = { options: { id: PI_AI_SETTINGS_NAMESPACE } }
    }
  })
  try {
    fiber = ctx.plugin(dshLlmPiAi, structuredClone(scope.get()) as never)
  } finally {
    stop()
  }
  await fiber.await()
  const mounted = fiber
  // Settings values are frozen, and the schema resolves the provider dict in
  // place, so each resolution gets its own copy.
  scope.watch(next => commitVolatile(mounted, dshLlmPiAi.Config(structuredClone(next) as never)))
  return mounted
}

/**
 * Headers a route may send besides the ones the provider sets itself. The
 * settings document is stored and described in plain text, and upstream
 * header values are plain strings, so only headers that never carry a secret
 * are accepted: OpenRouter's attribution headers and the OpenAI and Anthropic
 * identifiers that select an organization, project, or beta. The provider's
 * key belongs in its key field, which the credentials service keeps.
 */
const ALLOWED_ROUTE_HEADERS = new Set(['http-referer', 'referer', 'x-title', 'openai-organization', 'openai-project', 'anthropic-beta'])

/** Refuse a route header outside the allowlist, which could keep a credential in the settings document. */
export function requireAllowedHeaders(provider: string, headers: Record<string, unknown> | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    if (!ALLOWED_ROUTE_HEADERS.has(name.toLowerCase())) {
      throw new Error(`Provider "${provider}" may not send the header "${name}": route headers are stored in plain text, so only HTTP-Referer, Referer, X-Title, OpenAI-Organization, OpenAI-Project, and anthropic-beta are accepted. Enter the provider's API key in its key field.`)
    }
  }
}

/**
 * Credential names that belong to the deployment or to other Edge features:
 * DeepSeek's key (which also falls back to the Worker secret), MCP servers'
 * OAuth tokens, and Edge settings. A third-party route reading one would send
 * it to its own endpoint.
 */
const RESERVED_CREDENTIAL_NAME = /^(DEEPSEEK_|MCP_TOKEN_|DSH_EDGE_)/u

/**
 * Refuse a route without its own key name, or with one that would resolve
 * another feature's credential. Without a key name pi-ai discovers the key
 * from the process environment, where Workers expose the deployment's secrets.
 */
export function requireRouteCredentialName(provider: string, name: unknown): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Provider "${provider}" needs its own API key name, under which the Models page stores its key; a route without one would look for a key in the deployment's environment.`)
  }
  if (RESERVED_CREDENTIAL_NAME.test(name)) {
    throw new Error(`Provider "${provider}" may not use the credential "${name}", which belongs to DeepSeek or another Edge feature; give this provider its own key name.`)
  }
}

/**
 * A provider Base URL must be HTTP(S) with no credentials, query, or fragment
 * (a signed gateway URL would otherwise keep its token in the settings
 * document), as DEEPSEEK_SEARCH_BASE_URL must.
 */
export function requireProviderBaseURL(provider: string, value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`The Base URL of provider "${provider}" must be a valid HTTP(S) URL.`)
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username.length > 0 || parsed.password.length > 0
    || parsed.search.length > 0 || parsed.hash.length > 0 || /[?#]/u.test(value)) {
    throw new Error(`The Base URL of provider "${provider}" must be an HTTP(S) URL without credentials, a query, or a fragment.`)
  }
}

/**
 * Commit a parsed candidate's live values into a running fiber's references.
 * @param fiber - the provider's fiber; its parsed config holds the references the provider reads.
 * @param candidate - the same schema's parse of the new resolved settings.
 */
export function commitVolatile(fiber: Pick<Fiber, 'config' | 'ctx'>, candidate: unknown): void {
  const paths: (string | number)[][] = []
  for (const { path, ref } of volatileEntries(fiber.config)) {
    const source = path.reduce<unknown>((value, key) => Reflect.get(value as object, key), candidate)
    if (deepEqual(ref.get(), (source as typeof ref).get(), true)) continue
    updateVolatile(ref, source as typeof ref)
    paths.push([...path] as (string | number)[])
  }
  if (paths.length === 0) return
  // As the Loader does after a volatile-only update: tell the plugin itself
  // which values changed, so it can re-register what derives from them. The
  // plugin's listeners belong to its running fiber (`fiber.ctx.fiber`), which
  // is not the handle `ctx.plugin()` returned.
  const owner = fiber.ctx.fiber
  const self = Object.create(fiber.ctx) as Context
  ;(self as unknown as Record<symbol, unknown>)[Context.filter] = (candidate: Context) => candidate.fiber === owner
  try {
    ;(fiber.ctx.emit as (thisArg: Context, name: string, ...args: unknown[]) => void)(self, 'loader/volatile-update', paths)
  } catch (error) {
    fiber.ctx.logger.warn(error)
  }
}

/**
 * A 404 from the DeepSeek route most often means its endpoint does not serve
 * the Messages API (an OpenAI-compatible root or gateway); add how to fix
 * that to the provider's own failure text.
 */
function explainMissingMessagesEndpoint(ctx: Context): void {
  ctx.on('llm/stream', (options, next) => options.provider === DEEPSEEK_PROVIDER ? explained(next()) : next(), { global: true })
}

/**
 * Appended to the provider's own 404 text. A 404 usually means the endpoint
 * does not route Messages (0.18's OpenAI-compatible root, or such a gateway),
 * but a gateway may also answer 404 for a resource, so the hint is
 * conditional. It names no part of the endpoint: a gateway may carry a
 * credential in any URL component, and this message is persisted with the turn.
 */
const ENDPOINT_NOT_FOUND_HINT = 'If this began after upgrading from dsh-edge 0.18, the configured endpoint may not serve '
  + 'the Messages API: DeepSeek now needs an Anthropic-compatible endpoint such as https://api.deepseek.com/anthropic '
  + '(the Base URL on the Models settings page or the DEEPSEEK_BASE_URL Worker variable).'

/**
 * @internal Exported for tests. The runtime reports an adapter failure as the
 * stream's terminal `finish` chunk, so the 404 is rewritten there.
 */
export async function* explained(source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    if (chunk.type !== 'finish' || chunk.reason.kind !== 'error' || chunk.reason.failure.status !== 404) {
      yield chunk
      continue
    }
    yield {
      ...chunk,
      reason: {
        ...chunk.reason,
        failure: {
          ...chunk.reason.failure,
          message: `${chunk.reason.failure.message}${/[.!?]$/u.test(chunk.reason.failure.message) ? '' : '.'} ${ENDPOINT_NOT_FOUND_HINT}`,
        },
      },
    }
  }
}
