import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { installEdgeMcpServers, type EdgeMcpServerConfig } from '../src/edge-mcp-manager.ts'
import type { CachedMcpTool } from '../src/edge-mcp-tools.ts'

const MCP_STORAGE_KEY = 'dsh-edge:mcp-servers'
const MCP_TOOLS_PREFIX = 'dsh-edge:mcp-tools:'

function createMockStorage(): DurableObjectStorage & { readonly store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: (key: string) => Promise.resolve(store.has(key) ? structuredClone(store.get(key)) : undefined),
    put: (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'string') store.set(key, structuredClone(value))
      else for (const [k, v] of Object.entries(key)) store.set(k, structuredClone(v))
      return Promise.resolve()
    },
    delete: (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys]
      for (const k of arr) store.delete(k)
      return Promise.resolve(arr.length)
    },
    list: (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? ''
      const result = new Map<string, unknown>()
      for (const [k, v] of store) {
        if (k.startsWith(prefix)) result.set(k, v)
      }
      return Promise.resolve(result)
    },
  } as unknown as DurableObjectStorage & { readonly store: Map<string, unknown> }
}

function makeTool(name: string, serverName: string): CachedMcpTool {
  return {
    name,
    publicName: `mcp__${serverName}__${name}`,
    description: `Test tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  } as CachedMcpTool
}

async function createCtx(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('edge-mcp-storage-split', () => {
  it('migrates old cachedTools from config key to separate tools key', async () => {
    const storage = createMockStorage()
    const tools = [makeTool('get_data', 'testserver'), makeTool('set_data', 'testserver')]
    const oldConfig: EdgeMcpServerConfig[] = [{
      serverName: 'testserver',
      url: 'https://mcp.example.com',
      auth: { type: 'none' },
      status: 'connected',
      toolCount: 2,
      cachedTools: tools,
    }]
    storage.store.set(MCP_STORAGE_KEY, structuredClone(oldConfig))

    const ctx = await createCtx()
    const manager = installEdgeMcpServers(ctx, storage)
    await manager.ready

    // Tools should be migrated to separate key
    const storedTools = storage.store.get(MCP_TOOLS_PREFIX + 'testserver') as CachedMcpTool[] | undefined
    expect(storedTools).toBeDefined()
    expect(storedTools!).toHaveLength(2)
    expect(storedTools![0]!.name).toBe('get_data')

    // Config key should no longer contain cachedTools
    const storedConfig = storage.store.get(MCP_STORAGE_KEY) as EdgeMcpServerConfig[] | undefined
    expect(storedConfig![0]!.cachedTools).toBeUndefined()

    // Tools should be registered on ctx.tools
    expect(ctx.tools.get('mcp__testserver__get_data')).toBeDefined()
    expect(ctx.tools.get('mcp__testserver__set_data')).toBeDefined()

    manager.disposeAll()
  })

  it('reads tools from separate key when already split', async () => {
    const storage = createMockStorage()
    const tools = [makeTool('list_items', 'srv')]
    const config: EdgeMcpServerConfig[] = [{
      serverName: 'srv',
      url: 'https://mcp.example.com',
      auth: { type: 'none' },
      status: 'connected',
      toolCount: 1,
    }]
    storage.store.set(MCP_STORAGE_KEY, config)
    storage.store.set(MCP_TOOLS_PREFIX + 'srv', tools)

    const ctx = await createCtx()
    const manager = installEdgeMcpServers(ctx, storage)
    await manager.ready

    expect(ctx.tools.get('mcp__srv__list_items')).toBeDefined()

    // Config key should remain without cachedTools
    const storedConfig = storage.store.get(MCP_STORAGE_KEY) as EdgeMcpServerConfig[] | undefined
    expect(storedConfig![0]!.cachedTools).toBeUndefined()

    manager.disposeAll()
  })

  it('resolveToolPolicy uses cached config without extra reads', async () => {
    const storage = createMockStorage()
    const tools = [makeTool('get_quote', 'broker')]
    const config: EdgeMcpServerConfig[] = [{
      serverName: 'broker',
      url: 'https://mcp.example.com',
      auth: { type: 'none' },
      status: 'connected',
      toolCount: 1,
      toolPolicy: { mode: 'allow_all' },
    }]
    storage.store.set(MCP_STORAGE_KEY, config)
    storage.store.set(MCP_TOOLS_PREFIX + 'broker', tools)

    const ctx = await createCtx()
    const manager = installEdgeMcpServers(ctx, storage)
    await manager.ready

    const getSpy = vi.spyOn(storage as { get: typeof storage.get }, 'get')
    getSpy.mockClear()

    const result = await manager.resolveToolPolicy('mcp__broker__get_quote')
    expect(result).toBe('allow')
    // Should use cache, no storage reads
    expect(getSpy).not.toHaveBeenCalled()

    manager.disposeAll()
  })

  it('invalidateConfigCache forces re-read from storage', async () => {
    const storage = createMockStorage()
    const tools = [makeTool('get_data', 'srv')]
    const config: EdgeMcpServerConfig[] = [{
      serverName: 'srv',
      url: 'https://mcp.example.com',
      auth: { type: 'none' },
      status: 'connected',
      toolCount: 1,
      toolPolicy: { mode: 'read_only' },
    }]
    storage.store.set(MCP_STORAGE_KEY, config)
    storage.store.set(MCP_TOOLS_PREFIX + 'srv', tools)

    const ctx = await createCtx()
    const manager = installEdgeMcpServers(ctx, storage)
    await manager.ready

    // Update config in storage directly (simulating setMcpServers)
    const updated = structuredClone(config)
    updated[0]!.toolPolicy = { mode: 'allow_all' }
    storage.store.set(MCP_STORAGE_KEY, updated)
    manager.invalidateConfigCache()

    const result = await manager.resolveToolPolicy('mcp__srv__get_data')
    expect(result).toBe('allow')

    manager.disposeAll()
  })

  it('disposeServer clears tools from cache', async () => {
    const storage = createMockStorage()
    const tools = [makeTool('action', 'srv')]
    const config: EdgeMcpServerConfig[] = [{
      serverName: 'srv',
      url: 'https://mcp.example.com',
      auth: { type: 'none' },
      status: 'connected',
      toolCount: 1,
    }]
    storage.store.set(MCP_STORAGE_KEY, config)
    storage.store.set(MCP_TOOLS_PREFIX + 'srv', tools)

    const ctx = await createCtx()
    const manager = installEdgeMcpServers(ctx, storage)
    await manager.ready

    expect(ctx.tools.get('mcp__srv__action')).toBeDefined()

    manager.disposeServer('srv')
    expect(ctx.tools.get('mcp__srv__action')).toBeUndefined()

    manager.disposeAll()
  })
})
