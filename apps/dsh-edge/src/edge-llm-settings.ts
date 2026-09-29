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
import * as dshLlmDeepseekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { edgeSettings } from './edge-settings.ts'

/** Upstream's Loader entry id for the DeepSeek API-key provider, and its settings namespace. */
export const DEEPSEEK_SETTINGS_NAMESPACE = 'llm-deepseek'

/** Mount the DeepSeek API-key provider on the settings namespace the Models page edits. */
export async function mountDeepSeekProvider(ctx: Context, base: Record<string, unknown>): Promise<void> {
  const scope = edgeSettings(ctx).register(DEEPSEEK_SETTINGS_NAMESPACE, dshLlmDeepseekApiKey.Config, { base })
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
