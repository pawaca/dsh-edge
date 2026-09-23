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
  return GATED_TOOLS.has(exec.name) || exec.name.startsWith('mcp__') || exec.name === 'mcp_call'
}

export interface EdgeApprovalPolicyOptions {
  resolveMcpPolicy?: (publicName: string) => Promise<'allow' | 'ask' | undefined>
}

export function installEdgeApprovalPolicy(
  ctx: Context,
  options?: EdgeApprovalPolicyOptions,
): SettingsScope<EdgeApprovalSettings> {
  const scope = ctx.settings.register(APPROVAL_SETTINGS_NAMESPACE, EdgeApprovalSchema)

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!needsApproval(exec)) return next()
    // MCP tools: always consult per-connector policy (independent of global mode)
    if (exec.name.startsWith('mcp__') && options?.resolveMcpPolicy !== undefined) {
      const verdict = await options.resolveMcpPolicy(exec.name)
      if (verdict === 'allow') return next()
      return { kind: 'ask' as const }
    }
    // Meta-tool mode: resolve inner tool policy from mcp_call arguments
    if (exec.name === 'mcp_call' && options?.resolveMcpPolicy !== undefined) {
      const innerTool = (exec.arguments as { toolName?: string })?.toolName
      if (typeof innerTool === 'string') {
        const verdict = await options.resolveMcpPolicy(innerTool)
        if (verdict === 'allow') return next()
      }
      return { kind: 'ask' as const }
    }
    // Non-MCP gated tools (web_fetch): respect global mode
    const { mode } = scope.get()
    if (mode === 'never') return next()
    return { kind: 'ask' as const }
  })

  return scope
}
