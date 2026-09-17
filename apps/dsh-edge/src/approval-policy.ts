/** Edge-owned tool approval policy: reads user preference from settings and
 *  gates external tool calls through the upstream tools/pre-execute waterfall.
 *  Per-connector MCP policy refines when the global mode is 'ask'. */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

export const APPROVAL_SETTINGS_NAMESPACE = 'edge-approval'

const GATED_TOOLS = new Set(['web_fetch'])

export type EdgeApprovalMode = 'ask' | 'never'

export interface EdgeApprovalSettings {
  mode: EdgeApprovalMode
}

const EdgeApprovalSchema: Schema<EdgeApprovalSettings> = Schema.object({
  mode: Schema.union([Schema.const('ask' as const), Schema.const('never' as const)]).default('never' as const),
})

function needsApproval(exec: ToolExecution): boolean {
  return GATED_TOOLS.has(exec.name) || exec.name.startsWith('mcp__')
}

export interface EdgeApprovalPolicyOptions {
  defaultMode?: EdgeApprovalMode | undefined
  resolveMcpPolicy?: (publicName: string) => Promise<'allow' | 'ask' | undefined>
}

export function installEdgeApprovalPolicy(
  ctx: Context,
  options?: EdgeApprovalPolicyOptions,
): SettingsScope<EdgeApprovalSettings> {
  const schema = options?.defaultMode === 'never'
    ? Schema.object({
      mode: Schema.union([Schema.const('ask' as const), Schema.const('never' as const)]).default('never' as const),
    }) as Schema<EdgeApprovalSettings>
    : EdgeApprovalSchema

  const scope = ctx.settings.register(APPROVAL_SETTINGS_NAMESPACE, schema)

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!needsApproval(exec)) return next()
    const { mode } = scope.get()
    if (mode === 'never') return next()
    // Per-connector MCP policy: allow_all / read_only bypass approval
    if (exec.name.startsWith('mcp__') && options?.resolveMcpPolicy !== undefined) {
      const verdict = await options.resolveMcpPolicy(exec.name)
      if (verdict === 'allow') return next()
    }
    return { kind: 'ask' as const }
  })

  return scope
}
