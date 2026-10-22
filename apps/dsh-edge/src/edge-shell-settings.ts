/**
 * The Shell settings card's namespace. Upstream's card
 * (`dsh-client-ui-settings-shell`) edits `timeoutMs` and `maxOutputBytes` on
 * the shell executor's Loader entry, `bash-sandbox`; the Edge's bash is its
 * own, so it registers that namespace itself and reads it on every command:
 * a saved value applies from the next command, in both shells and the HTTP
 * exec route.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { edgeSettings, type EdgeSettingsScope } from './edge-settings.ts'
import { SHELL_OUTPUT_TAIL_BYTES } from './edge-shell-output.ts'
import type { EdgeCommandTimeoutPolicy } from './workspace.ts'

/** Upstream's Loader entry id for the POSIX shell executor, and the namespace its card edits. */
export const SHELL_SETTINGS_NAMESPACE = 'bash-sandbox'
/**
 * The per-stream inline tail an owner may choose. Each stream holds this much
 * in memory while a command runs, so it is bounded above; below 1 KiB the
 * model would see too little to act on.
 */
export const SHELL_OUTPUT_BYTES_RANGE = { min: 1024, max: 1024 * 1024 } as const

export interface EdgeShellSettings {
  /** Default timeout of a command that names none; the deployment's ceiling still bounds it. */
  timeoutMs: number
  /** Bytes of each stream kept inline; the rest spills to a file. */
  maxOutputBytes: number
}

/**
 * Register the namespace over the deployment's timeouts: the default comes
 * from `DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS`, and a saved timeout above
 * `DSH_EDGE_MAX_COMMAND_TIMEOUT_MS` is refused.
 */
export function installEdgeShellSettings(
  ctx: Context,
  policy: EdgeCommandTimeoutPolicy,
): EdgeSettingsScope<EdgeShellSettings> {
  const schema = Schema.object({
    timeoutMs: Schema.number().default(policy.defaultTimeoutMs),
    maxOutputBytes: Schema.number().default(SHELL_OUTPUT_TAIL_BYTES),
  }) as unknown as Schema<EdgeShellSettings>
  return edgeSettings(ctx).register(SHELL_SETTINGS_NAMESPACE, schema, {
    validate: ({ timeoutMs, maxOutputBytes }) => {
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > policy.maxTimeoutMs) {
        throw new Error(`Command timeout must be a whole number of milliseconds from 1 to ${String(policy.maxTimeoutMs)}.`)
      }
      if (!Number.isInteger(maxOutputBytes)
        || maxOutputBytes < SHELL_OUTPUT_BYTES_RANGE.min || maxOutputBytes > SHELL_OUTPUT_BYTES_RANGE.max) {
        throw new Error(`Output cap per stream must be a whole number of bytes from ${String(SHELL_OUTPUT_BYTES_RANGE.min)} to ${String(SHELL_OUTPUT_BYTES_RANGE.max)}.`)
      }
    },
    // A section a lowered deployment ceiling made invalid falls back to the defaults.
    discardInvalidSection: true,
  })
}

/** The timeout policy a command runs under: the saved default within the deployment's ceiling. */
export function liveTimeoutPolicy(policy: EdgeCommandTimeoutPolicy, settings: EdgeShellSettings): EdgeCommandTimeoutPolicy {
  return { defaultTimeoutMs: Math.min(settings.timeoutMs, policy.maxTimeoutMs), maxTimeoutMs: policy.maxTimeoutMs }
}
