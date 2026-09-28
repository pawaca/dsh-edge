import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_AGENT_PRESET,
  EdgeAgentPresets,
  PTC_AGENT_PRESET,
  edgeAgentPresetRows,
  sessionAgentPreset,
} from '../src/agent-presets.ts'

const header: SessionHeader = {
  id: SessionId('session-preset'),
  version: SESSION_FORMAT_VERSION,
  createdAt: 1,
  isSeeded: false,
  agentPreset: DEFAULT_AGENT_PRESET,
}

function agentScope() {
  const presentAs = vi.fn(() => () => {})
  const restrict = vi.fn(() => () => {})
  return { ctx: { tools: { presentAs, restrict } } as unknown as Context, presentAs, restrict }
}

describe('Edge agent presets', () => {
  it('offers PTC mode only with a code runtime', () => {
    expect(edgeAgentPresetRows(false).map(row => row.id)).toEqual([DEFAULT_AGENT_PRESET])
    expect(edgeAgentPresetRows(true).map(row => [row.id, row.isDefault]))
      .toEqual([[DEFAULT_AGENT_PRESET, true], [PTC_AGENT_PRESET, false]])
  })

  it('offers PTC mode under the upstream id, leaving its copy to the client', () => {
    const ptc = edgeAgentPresetRows(true).find(row => row.id === PTC_AGENT_PRESET)
    // The Web client localizes a system preset whose id is upstream's `ptc`.
    expect(ptc).toEqual({ id: 'ptc', trust: 'system', isDefault: false })
  })

  it('reads the preset from the durable header', () => {
    expect(sessionAgentPreset({ ...header, agentPreset: PTC_AGENT_PRESET })).toBe(PTC_AGENT_PRESET)
    const { agentPreset: _recorded, ...unrecorded } = header
    expect(sessionAgentPreset(unrecorded)).toBe(DEFAULT_AGENT_PRESET)
  })

  it('presents a PTC mode agent through run_code alone and children inherit it', async () => {
    const root = new Context()
    await root.plugin(EdgeAgentPresets, { codeRuntime: true })
    const presets = root.get('agentPresets') as EdgeAgentPresets
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
    const root = new Context()
    await root.plugin(EdgeAgentPresets, { codeRuntime: false })
    const presets = root.get('agentPresets') as EdgeAgentPresets
    const agent = agentScope()
    presets.join(agent.ctx, PTC_AGENT_PRESET)
    expect(agent.presentAs).not.toHaveBeenCalled()
    expect(presets.composedPreset(agent.ctx)).toBe(DEFAULT_AGENT_PRESET)
    await expect(presets.resolve(PTC_AGENT_PRESET)).rejects.toThrow(/not available/u)
  })
})
