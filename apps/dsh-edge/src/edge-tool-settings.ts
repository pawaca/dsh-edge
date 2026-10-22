/**
 * Owner switches for optional model tools.
 *
 * Upstream ships `dsh-tool-session-query` as an experimental opt-in package,
 * in none of its presets: its five tools add their schemas to every request,
 * and every session in one Edge instance shares the `/workspace` cwd its
 * authorization compares, so each can read every other. The Edge therefore
 * mounts it only while the owner turns it on, and a change applies from the
 * next model request without a restart.
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { edgeSettings, type EdgeSettingsScope } from './edge-settings.ts'

export const TOOL_SETTINGS_NAMESPACE = 'edge-tools'

export interface EdgeToolSettings {
  /** Mount upstream's session_search, session_event_search, session_trace, session_event_trace, and session_event_read. */
  sessionQuery: boolean
}

const EdgeToolSettingsSchema: Schema<EdgeToolSettings> = Schema.object({
  sessionQuery: Schema.boolean().default(false),
}) as unknown as Schema<EdgeToolSettings>

export interface EdgeToolSettingsHandle {
  readonly scope: EdgeSettingsScope<EdgeToolSettings>
  /**
   * Bring the mounted tools to the current settings, after any change already
   * queued; rejects when that mount or disposal fails. The settings watcher
   * applies a change asynchronously, so an owner update awaits this before
   * acknowledging it.
   */
  readonly sync: () => Promise<void>
  /**
   * Retry a mount the saved setting calls for but that failed (at start, say),
   * so the tools come back without the owner toggling them; logs and returns
   * when it fails again. Cheap when the mounted state already matches.
   */
  readonly ensure: () => Promise<void>
}

/**
 * Register the namespace and keep the session-query tools mounted while it
 * says so. Mounts and disposals run one at a time in the order of changes.
 */
export async function installEdgeToolSettings(
  ctx: Context,
  /** Load the plugin to mount; tests substitute one. */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  load: () => Promise<Parameters<Context['plugin']>[0]> = () => import('@deepseek-ai/dsh-tool-session-query' as string),
): Promise<EdgeToolSettingsHandle> {
  const scope = edgeSettings(ctx).register(TOOL_SETTINGS_NAMESPACE, EdgeToolSettingsSchema)
  let fiber: Fiber | undefined
  let applied = Promise.resolve()
  const apply = (enabled: boolean): Promise<void> => {
    // A failed change rejects its own caller but does not block later ones,
    // and `fiber` changes only once a mount or disposal succeeds, so the next
    // application of the same value retries it.
    const run = applied.catch(() => {}).then(async () => {
      if (enabled && fiber === undefined) {
        const mounted = ctx.plugin(await load())
        try {
          await mounted.await()
        } catch (error) {
          await mounted.dispose().catch(() => {})
          throw error
        }
        fiber = mounted
      } else if (!enabled && fiber !== undefined) {
        await fiber.dispose()
        fiber = undefined
      }
    })
    applied = run
    return run
  }
  // A failed mount at start leaves the tools off; the next update retries it.
  await apply(scope.get().sessionQuery).catch((error: unknown) => {
    console.error('dsh-edge: could not mount the session-query tools', error)
  })
  scope.watch(next => apply(next.sessionQuery))
  return {
    scope,
    sync: () => apply(scope.get().sessionQuery),
    ensure: async () => {
      if (scope.get().sessionQuery === (fiber !== undefined)) return
      await apply(scope.get().sessionQuery).catch((error: unknown) => {
        console.error('dsh-edge: could not mount the session-query tools', error)
      })
    },
  }
}

/** Validate an owner's partial update, returning an error message for invalid input. */
export function parseToolSettingsPatch(body: unknown): Partial<EdgeToolSettings> | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object'
  const patch: Partial<EdgeToolSettings> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key !== 'sessionQuery') return `unknown setting: ${key}`
    if (typeof value !== 'boolean') return 'sessionQuery must be a boolean'
    patch.sessionQuery = value
  }
  return patch
}
