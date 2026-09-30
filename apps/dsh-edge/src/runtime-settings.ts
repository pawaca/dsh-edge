/**
 * Owner-adjustable runtime settings. Both apply to the next command without a
 * restart: routing is read per command, and the sleep window is read whenever
 * the idle deadline is computed. Which providers exist is fixed by the
 * deployment's bindings (`runtime-provider.ts`), not by settings.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { edgeSettings, type EdgeSettingsScope } from './edge-settings.ts'
import type { BashRoutingPolicy } from './bash-routing.ts'

export const RUNTIME_SETTINGS_NAMESPACE = 'edge-runtime'

/** The idle windows the Settings page offers, in minutes. */
export const CONTAINER_SLEEP_MINUTES = [5, 10, 30] as const

export type ContainerSleepMinutes = typeof CONTAINER_SLEEP_MINUTES[number]

export interface EdgeRuntimeSettings {
  bashRouting: BashRoutingPolicy
  containerSleepMinutes: ContainerSleepMinutes
}

const DEFAULT_RUNTIME_SETTINGS: Readonly<EdgeRuntimeSettings> = Object.freeze({
  bashRouting: 'auto',
  containerSleepMinutes: 10,
})

const BASH_ROUTING_POLICIES: readonly BashRoutingPolicy[] = ['auto', 'light', 'container']

const EdgeRuntimeSettingsSchema: Schema<EdgeRuntimeSettings> = Schema.object({
  bashRouting: Schema.union(BASH_ROUTING_POLICIES.map(policy => Schema.const(policy)))
    .default(DEFAULT_RUNTIME_SETTINGS.bashRouting),
  containerSleepMinutes: Schema.union(CONTAINER_SLEEP_MINUTES.map(minutes => Schema.const(minutes)))
    .default(DEFAULT_RUNTIME_SETTINGS.containerSleepMinutes),
}) as unknown as Schema<EdgeRuntimeSettings>

export function installEdgeRuntimeSettings(ctx: Context): EdgeSettingsScope<EdgeRuntimeSettings> {
  return edgeSettings(ctx).register(RUNTIME_SETTINGS_NAMESPACE, EdgeRuntimeSettingsSchema)
}

/** Validate an owner's partial update, returning an error message for invalid input. */
export function parseRuntimeSettingsPatch(body: unknown): Partial<EdgeRuntimeSettings> | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object'
  const patch: Partial<EdgeRuntimeSettings> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'bashRouting') {
      if (!BASH_ROUTING_POLICIES.includes(value as BashRoutingPolicy)) {
        return 'bashRouting must be "auto", "light", or "container"'
      }
      patch.bashRouting = value as BashRoutingPolicy
    } else if (key === 'containerSleepMinutes') {
      if (!CONTAINER_SLEEP_MINUTES.includes(value as ContainerSleepMinutes)) {
        return 'containerSleepMinutes must be 5, 10, or 30'
      }
      patch.containerSleepMinutes = value as ContainerSleepMinutes
    } else {
      return `unknown setting: ${key}`
    }
  }
  return patch
}
