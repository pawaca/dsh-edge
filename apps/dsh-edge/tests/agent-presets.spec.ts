import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PRESET_SETTINGS_NAMESPACE,
  DEFAULT_AGENT_PRESET,
  EdgeAgentPresets,
  PTC_AGENT_PRESET,
  normalizeAgentPreset,
  sessionAgentPreset,
} from '../src/agent-presets.ts'
import { EdgeSettings } from '../src/edge-settings.ts'

const header: SessionHeader = {
  id: SessionId('session-preset'),
  version: SESSION_FORMAT_VERSION,
  createdAt: 1,
  isSeeded: false,
  agentPreset: DEFAULT_AGENT_PRESET,
}

/** Durable Object KV stand-in for the settings document. */
function memoryStorage(): DurableObjectStorage {
  const store = new Map<string, unknown>()
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
    delete: (key: string) => Promise.resolve(store.delete(key)),
  } as unknown as DurableObjectStorage
}

async function edgePresets(codeRuntime: boolean, storage = memoryStorage()): Promise<EdgeAgentPresets> {
  const root = new Context()
  await root.plugin(EdgeSettings, { storage })
  await root.plugin(EdgeAgentPresets, { codeRuntime })
  return root.get('agentPresets') as EdgeAgentPresets
}

function agentScope() {
  const presentAs = vi.fn(() => () => {})
  const restrict = vi.fn(() => () => {})
  return { ctx: { tools: { presentAs, restrict } } as unknown as Context, presentAs, restrict }
}

describe('Edge agent presets', () => {
  it('offers PTC mode only with a code runtime', async () => {
    expect((await edgePresets(false)).rows().map(row => row.id)).toEqual([DEFAULT_AGENT_PRESET])
    expect((await edgePresets(true)).rows().map(row => [row.id, row.isDefault]))
      .toEqual([[DEFAULT_AGENT_PRESET, true], [PTC_AGENT_PRESET, false]])
  })

  it('uses upstream ids so the client shows its bilingual copy for both presets', async () => {
    // No name or description: the Web client localizes upstream's `standard` and `ptc`.
    expect((await edgePresets(true)).rows()).toEqual([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'ptc', trust: 'system', isDefault: false },
    ])
  })

  it('starts new sessions on the default the Settings page writes, as upstream', async () => {
    const root = new Context()
    const storage = memoryStorage()
    await root.plugin(EdgeSettings, { storage })
    await root.plugin(EdgeAgentPresets, { codeRuntime: true })
    const presets = root.get('agentPresets') as EdgeAgentPresets
    await root.settings.update(AGENT_PRESET_SETTINGS_NAMESPACE, { default: PTC_AGENT_PRESET })
    expect(presets.defaultPreset()).toBe(PTC_AGENT_PRESET)
    expect(presets.rows().map(row => [row.id, row.isDefault]))
      .toEqual([[DEFAULT_AGENT_PRESET, false], [PTC_AGENT_PRESET, true]])
    await expect(presets.resolve()).resolves.toMatchObject({ id: PTC_AGENT_PRESET, isDefault: true })
    await expect(root.settings.update(AGENT_PRESET_SETTINGS_NAMESPACE, { default: 'cordis' }))
      .rejects.toThrow(/not available/u)
    expect(presets.defaultPreset()).toBe(PTC_AGENT_PRESET)

    // The stored default survives a restart; without the Loader it reads as standard.
    await root.fiber.dispose()
    const restarted = await edgePresets(false, storage)
    expect(restarted.defaultPreset()).toBe(DEFAULT_AGENT_PRESET)
    expect(restarted.rows()).toEqual([{ id: 'standard', trust: 'system', isDefault: true }])
  })

  it('reads the legacy default id as standard wherever a preset is stored or requested', () => {
    expect(normalizeAgentPreset('dsh-edge')).toBe('standard')
    expect(normalizeAgentPreset('ptc')).toBe('ptc')
    expect(sessionAgentPreset({ ...header, agentPreset: 'dsh-edge' })).toBe('standard')
  })

  it('reads the preset from the durable header', () => {
    expect(sessionAgentPreset({ ...header, agentPreset: PTC_AGENT_PRESET })).toBe(PTC_AGENT_PRESET)
    const { agentPreset: _recorded, ...unrecorded } = header
    expect(sessionAgentPreset(unrecorded)).toBe(DEFAULT_AGENT_PRESET)
  })

  it('presents a PTC mode agent through run_code alone and children inherit it', async () => {
    const presets = await edgePresets(true)
    const parent = agentScope()
    presets.join(parent.ctx, PTC_AGENT_PRESET)
    expect(parent.presentAs).toHaveBeenCalledWith('ptc')
    expect(parent.restrict).toHaveBeenCalledWith({ deny: ['workflow'] })
    expect(presets.composedPreset(parent.ctx)).toBe(PTC_AGENT_PRESET)

    const child = agentScope()
    presets.composeFrom(child.ctx, parent.ctx)
    expect(child.presentAs).toHaveBeenCalledWith('ptc')

    const native = agentScope()
    presets.join(native.ctx, DEFAULT_AGENT_PRESET)
    expect(native.presentAs).not.toHaveBeenCalled()
    expect(native.restrict).not.toHaveBeenCalled()
  })

  it('runs a recorded PTC mode session natively once the code runtime is gone', async () => {
    const presets = await edgePresets(false)
    const agent = agentScope()
    presets.join(agent.ctx, PTC_AGENT_PRESET)
    expect(agent.presentAs).not.toHaveBeenCalled()
    expect(presets.composedPreset(agent.ctx)).toBe(DEFAULT_AGENT_PRESET)
    await expect(presets.resolve(PTC_AGENT_PRESET)).rejects.toThrow(/not available/u)
  })
})
