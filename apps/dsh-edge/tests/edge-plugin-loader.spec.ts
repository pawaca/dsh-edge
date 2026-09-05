import { Context, Service } from '@deepseek-ai/cordis'
import PluginInventoryGateway from '@deepseek-ai/dsh-host-plugin-inventory'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types'
import { describe, expect, it } from 'vitest'
import bootGraph from '../standalone/expected-boot-graph.json' with { type: 'json' }
import { EdgeLoader, HOST_ENTRY_PREFIX, WEB_ENTRY_PREFIX } from '../src/edge-plugin-loader.ts'

class Probe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'probe')
  }
}

async function composedContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Probe)
  await ctx.plugin({ name: 'edge-named-plugin', apply() {} })
  await ctx.plugin({ name: 'edge-named-plugin', apply() {} })
  await ctx.inject([], () => {})
  await ctx.plugin(EdgeLoader)
  return ctx
}

describe('EdgeLoader', () => {
  it('projects named host runtimes with their live root fiber, then the reviewed Web boot graph', async () => {
    const ctx = await composedContext()
    const entries = [...ctx.loader.entries()]
    const hostEntries = entries.filter(entry => entry.id.startsWith(HOST_ENTRY_PREFIX))
    const webEntries = entries.filter(entry => entry.id.startsWith(WEB_ENTRY_PREFIX))

    expect(hostEntries.length + webEntries.length).toBe(entries.length)
    expect(hostEntries.map(entry => entry.id)).toEqual([
      'host:Probe',
      'host:edge-named-plugin',
      'host:edge-named-plugin#2',
      'host:EdgeLoader',
    ])
    expect(hostEntries.every(entry => entry.options.name !== '' && entry.disabled === false)).toBe(true)
    expect(hostEntries.every(entry => entry.fiber?.state === 2)).toBe(true)

    expect(webEntries.map(entry => entry.id)).toEqual(bootGraph.map(entry => `web:${entry.id}`))
    expect(webEntries.every(entry => entry.disabled === false && entry.fiber?.state === 2)).toBe(true)
    expect(entries.indexOf(hostEntries[hostEntries.length - 1]!)).toBeLessThan(entries.indexOf(webEntries[0]!))
  })

  it('serves the upstream pluginInventory gateway without a cordis Loader', async () => {
    const ctx = await composedContext()
    const EdgeAgentPresets = class extends Service {
      constructor(ctx: Context) {
        super(ctx, 'agentPresets')
      }

      async compositionInventory(): Promise<readonly never[]> {
        return []
      }
    }
    await ctx.plugin(EdgeAgentPresets)
    await ctx.plugin(PluginInventoryGateway)

    const gateway = ctx.get('pluginInventory') as { list(): Promise<PluginInventorySnapshot> }
    const snapshot = await gateway.list()

    expect(snapshot.entries.find(entry => entry.entryId === 'host:Probe')).toEqual({
      entryId: 'host:Probe',
      moduleName: 'Probe',
      enabled: true,
      fiberPhase: 'active',
    })
    expect(snapshot.entries.find(entry => entry.entryId === 'host:PluginInventoryGateway')?.fiberPhase)
      .toBe('active')
    expect(snapshot.entries.find(
      entry => entry.entryId === 'web:@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
    )).toEqual({
      entryId: 'web:@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
      moduleName: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
      enabled: true,
      fiberPhase: 'active',
    })
    expect(snapshot.entries.filter(entry => entry.entryId.startsWith(WEB_ENTRY_PREFIX)).length)
      .toBe(bootGraph.length)
    expect(snapshot.agentPresets).toEqual([])
  })

  it('keeps the plugin settings surfaces in the reviewed Web boot graph', () => {
    const ids = new Set(bootGraph.map(entry => entry.id))
    expect(ids.has('@deepseek-ai/dsh-client-ui-settings-plugins')).toBe(true)
    expect(ids.has('@deepseek-ai/dsh-client-ui-settings-plugin-inventory')).toBe(true)
  })
})
