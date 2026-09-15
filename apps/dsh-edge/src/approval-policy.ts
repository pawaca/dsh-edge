/** Edge-owned tool approval policy: reads user preference from settings and
 *  gates external tool calls through the upstream tools/pre-execute waterfall. */

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
  mode: Schema.union([Schema.const('ask' as const), Schema.const('never' as const)]).default('ask' as const),
})

function needsApproval(exec: ToolExecution): boolean {
  return GATED_TOOLS.has(exec.name) || exec.name.startsWith('mcp__')
}

export function installEdgeApprovalPolicy(ctx: Context): SettingsScope<EdgeApprovalSettings> {
  const scope = ctx.settings.register(APPROVAL_SETTINGS_NAMESPACE, EdgeApprovalSchema)

  ctx.on('tools/pre-execute', (exec, next) => {
    if (!needsApproval(exec)) return next()
    const { mode } = scope.get()
    if (mode === 'never') return next()
    return Promise.resolve({ kind: 'ask' as const })
  })

  return scope
}
