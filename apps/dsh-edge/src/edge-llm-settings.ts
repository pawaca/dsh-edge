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
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { deepEqual, updateVolatile, volatileEntries } from '@deepseek-ai/cosmokit'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as dshLlmDeepseekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
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

/**
 * Commit a parsed candidate's live values into a running fiber's references.
 * @param fiber - the provider's fiber; its parsed config holds the references the provider reads.
 * @param candidate - the same schema's parse of the new resolved settings.
 */
export function commitVolatile(fiber: Pick<Fiber, 'config'>, candidate: unknown): void {
  for (const { path, ref } of volatileEntries(fiber.config)) {
    const source = path.reduce<unknown>((value, key) => Reflect.get(value as object, key), candidate)
    if (!deepEqual(ref.get(), (source as typeof ref).get(), true)) updateVolatile(ref, source as typeof ref)
  }
}

/**
 * A 404 from the DeepSeek route means its endpoint does not serve the
 * Messages API (an OpenAI-compatible root or gateway); say so and how to fix
 * it instead of a bare status.
 */
function explainMissingMessagesEndpoint(ctx: Context): void {
  ctx.on('llm/stream', (options, next) => options.provider === DEEPSEEK_PROVIDER ? explained(next()) : next(), { global: true })
}

/**
 * Names no part of the endpoint: a gateway may carry a credential in any
 * component of its URL, and this message is persisted with the turn. The
 * owner configures a single DeepSeek endpoint, in one of the two places named.
 */
const ENDPOINT_NOT_FOUND_MESSAGE = 'The configured DeepSeek endpoint does not serve the Messages API (404). DeepSeek now needs '
  + 'an Anthropic-compatible endpoint such as https://api.deepseek.com/anthropic; change the Base URL on the Models '
  + 'settings page or the DEEPSEEK_BASE_URL Worker variable.'

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
          message: ENDPOINT_NOT_FOUND_MESSAGE,
        },
      },
    }
  }
}
