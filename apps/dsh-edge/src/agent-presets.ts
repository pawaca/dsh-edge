/**
 * The Edge agent presets, under upstream ids so the Web client shows its
 * built-in bilingual names and descriptions. Every deployment offers
 * `standard` (Standard mode), whose tools are presented natively. Deployments
 * with a Worker Loader also offer `ptc` (PTC mode): the model reaches every tool
 * through one `run_code` TypeScript program, and `workflow` is not offered
 * because `run_code` is the only orchestration surface.
 *
 * A session runs the preset its durable header names. Selecting a preset for
 * a blank session records the upstream `agent-preset/selected` event, and the
 * persistence backend rewrites the header in the same transaction, so every
 * reader (summaries, resume, fork, subagents) reads one bounded value. Tools
 * and prompt sections stay mounted globally; a preset only changes how one
 * agent's scope presents them.
 *
 * Plugins that compose per agent, as upstream's delegation tool does with
 * model selection on, mount in the composition scope: `join` places every
 * agent's scope under it, whatever its preset.
 *
 * As upstream, new sessions start on the `default` field of the
 * `agent-presets` settings namespace, which the Settings page writes.
 */

import { Service as CordisService, type Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Schema from '@deepseek-ai/schemastery'
import { edgeSettings, type EdgeSettingsScope } from './edge-settings.ts'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

// The upstream event the preset host records; declared here because the Edge
// serves agentPresets itself instead of loading the upstream host package.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'agent-preset/selected': { agentPreset: string }
  }
}

export const DEFAULT_AGENT_PRESET = 'standard'
export const PTC_AGENT_PRESET = 'ptc'
export const AGENT_PRESET_SETTINGS_NAMESPACE = 'agent-presets'
/** The id releases up to 0.18.0-alpha.2 stored for the default preset. */
const LEGACY_DEFAULT_AGENT_PRESET = 'dsh-edge'

/** Read a stored or requested preset id; the legacy default id means `standard`. */
export function normalizeAgentPreset(id: string): string {
  return id === LEGACY_DEFAULT_AGENT_PRESET ? DEFAULT_AGENT_PRESET : id
}

export interface EdgeAgentPresetRow {
  id: string
  trust: 'system'
  isDefault: boolean
}

const PRESET_IDS: readonly string[] = [DEFAULT_AGENT_PRESET, PTC_AGENT_PRESET]

/** The presets a deployment offers; PTC mode needs the Worker Loader that runs `run_code`. */
export function edgeAgentPresetIds(codeRuntime: boolean): string[] {
  return PRESET_IDS.filter(id => codeRuntime || id !== PTC_AGENT_PRESET)
}

interface AgentPresetSettings {
  default: string
}

const AgentPresetSettingsSchema = Schema.object({
  default: Schema.string().default(DEFAULT_AGENT_PRESET),
}) as unknown as Schema<AgentPresetSettings>

/** The preset a session runs, from its durable header. */
export function sessionAgentPreset(header: SessionHeader): string {
  return normalizeAgentPreset(header.agentPreset ?? DEFAULT_AGENT_PRESET)
}

/**
 * The `agentPresets` service the upstream controller and subagent runtime
 * consult. `join` composes one agent scope from a preset; the subagent runtime
 * stamps a child's header with `composedPreset` and joins the child's scope
 * through `composeFrom`, so children run their parent's preset.
 */
export class EdgeAgentPresets extends CordisService {
  static inject = ['settings']

  private readonly composed = new WeakMap<Context, string>()
  private readonly settings: EdgeSettingsScope<AgentPresetSettings>
  private readonly compositionKey = {}
  private readonly composition: ReturnType<typeof createScope>

  constructor(ctx: Context, private readonly config: { codeRuntime: boolean }) {
    super(ctx, 'agentPresets')
    this.composition = createScope(ctx, this.compositionKey)
    this.settings = edgeSettings(ctx).register(AGENT_PRESET_SETTINGS_NAMESPACE, AgentPresetSettingsSchema, {
      // Checked against every Edge preset rather than this deployment's offer:
      // a stored `ptc` must not fail registration after the Loader is removed.
      validate: ({ default: id }) => {
        if (!PRESET_IDS.includes(normalizeAgentPreset(id))) {
          throw new Error(`Agent preset "${id}" is not available.`)
        }
      },
    })
  }

  /** The preset new sessions start on; one this deployment no longer offers reads as `standard`. */
  defaultPreset(): string {
    const id = normalizeAgentPreset(this.settings.get().default)
    return this.offers(id) ? id : DEFAULT_AGENT_PRESET
  }

  // No name or description: the client localizes upstream's built-in ids itself.
  rows(): EdgeAgentPresetRow[] {
    const defaultId = this.defaultPreset()
    return edgeAgentPresetIds(this.config.codeRuntime)
      .map(id => ({ id, trust: 'system' as const, isDefault: id === defaultId }))
  }

  offers(presetId: string): boolean {
    return edgeAgentPresetIds(this.config.codeRuntime).includes(normalizeAgentPreset(presetId))
  }

  async resolve(presetId?: string): Promise<{ id: string; trust: 'system'; isDefault: boolean }> {
    const id = presetId === undefined ? this.defaultPreset() : normalizeAgentPreset(presetId)
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
    const id = this.offers(presetId) ? normalizeAgentPreset(presetId) : DEFAULT_AGENT_PRESET
    this.composed.set(agentCtx, id)
    // A child is joined twice (its own composition, then its parent's preset);
    // its scope is placed under the composition once.
    const scope = scopeOf(agentCtx)
    if (scope !== undefined && scopeParentOf(scope) === undefined) bindScopeParent(scope, this.compositionKey)
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

  /** The scoped context whose registrations every joined agent sees. */
  compositionContext(): Context {
    return this.composition.ctx
  }

  composedPreset(ctx: Context): string {
    return this.composed.get(ctx) ?? DEFAULT_AGENT_PRESET
  }

  composeFrom(childCtx: Context, parentCtx: Context): void {
    this.join(childCtx, this.composedPreset(parentCtx))
  }

  /** No preset mounts its own services; callers fall back to the global one. */
  serviceFor(_agent: { ctx: Context }, _name: string): undefined {
    return undefined
  }
}
