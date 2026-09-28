/**
 * The Edge agent presets. Every deployment offers `dsh-edge`, whose tools are
 * presented natively. Deployments with a Worker Loader also offer PTC mode,
 * which mirrors the upstream `ptc` preset: the model reaches every tool through
 * one `run_code` TypeScript program, and `workflow` is not offered because
 * `run_code` is the only orchestration surface.
 *
 * A session runs the preset its durable header names. Selecting a preset for
 * a blank session records the upstream `agent-preset/selected` event, and the
 * persistence backend rewrites the header in the same transaction, so every
 * reader (summaries, resume, fork, subagents) reads one bounded value. Tools
 * and prompt sections stay mounted globally; a preset only changes how one
 * agent's scope presents them.
 */

import { Service as CordisService, type Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

// The upstream event the preset host records; declared here because the Edge
// serves agentPresets itself instead of loading the upstream host package.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'agent-preset/selected': { agentPreset: string }
  }
}

export const DEFAULT_AGENT_PRESET = 'dsh-edge'
export const PTC_AGENT_PRESET = 'dsh-edge-ptc'

export interface EdgeAgentPresetRow {
  id: string
  trust: 'system'
  isDefault: boolean
  name: string
  description: string
}

const PRESETS: readonly EdgeAgentPresetRow[] = [
  {
    id: DEFAULT_AGENT_PRESET,
    trust: 'system',
    isDefault: true,
    name: 'DSH Edge',
    description: 'DeepSeek Harness running in a Cloudflare Durable Object.',
  },
  {
    id: PTC_AGENT_PRESET,
    trust: 'system',
    isDefault: false,
    name: 'PTC mode',
    description: 'The full coding agent, with every tool presented through a TypeScript SDK so the model '
      + 'composes multi-step work in one run_code program. The workflow tool is not offered.',
  },
]

/** The presets a deployment offers; PTC mode needs the Worker Loader that runs `run_code`. */
export function edgeAgentPresetRows(codeRuntime: boolean): EdgeAgentPresetRow[] {
  return PRESETS.filter(preset => codeRuntime || preset.id !== PTC_AGENT_PRESET)
}

/** The preset a session runs, from its durable header. */
export function sessionAgentPreset(header: SessionHeader): string {
  return header.agentPreset ?? DEFAULT_AGENT_PRESET
}

/**
 * The `agentPresets` service the upstream controller and subagent runtime
 * consult. `join` composes one agent scope from a preset; the subagent runtime
 * stamps a child's header with `composedPreset` and joins the child's scope
 * through `composeFrom`, so children run their parent's preset.
 */
export class EdgeAgentPresets extends CordisService {
  private readonly composed = new WeakMap<Context, string>()

  constructor(ctx: Context, private readonly config: { codeRuntime: boolean }) {
    super(ctx, 'agentPresets')
  }

  rows(): EdgeAgentPresetRow[] {
    return edgeAgentPresetRows(this.config.codeRuntime)
  }

  offers(presetId: string): boolean {
    return this.rows().some(row => row.id === presetId)
  }

  async resolve(presetId?: string): Promise<{ id: string; trust: 'system'; isDefault: boolean }> {
    const id = presetId ?? DEFAULT_AGENT_PRESET
    const row = this.rows().find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`Agent preset "${id}" is not available.`)
    return { id: row.id, trust: row.trust, isDefault: row.isDefault }
  }

  /**
   * Compose one agent scope from `presetId`. A preset this deployment no
   * longer offers (PTC mode after the Loader is removed) falls back to the
   * default rather than stranding the session.
   */
  join(agentCtx: Context, presetId: string): void {
    const id = this.offers(presetId) ? presetId : DEFAULT_AGENT_PRESET
    this.composed.set(agentCtx, id)
    if (id === PTC_AGENT_PRESET) {
      agentCtx.tools.presentAs('ptc')
      agentCtx.tools.restrict({ deny: ['workflow'] })
    }
  }

  async mount(): Promise<void> {
    // Tools and prompt sections are mounted globally; `join` composes each agent.
  }

  async compositionInventory(): Promise<readonly never[]> {
    // No per-preset composition rows: the plugin inventory lists the
    // global composition and the browser boot graph instead.
    return []
  }

  composedPreset(ctx: Context): string {
    return this.composed.get(ctx) ?? DEFAULT_AGENT_PRESET
  }

  composeFrom(childCtx: Context, parentCtx: Context): void {
    this.join(childCtx, this.composedPreset(parentCtx))
  }
}
