import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import McpResourceRuntime from '@deepseek-ai/dsh-mcp-resources'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { byteCappedFetch, probe, requestResources } from '../src/edge-mcp-client.ts'
import { MCP_LIMITS } from '../src/edge-mcp-limits.ts'
import { installEdgeApprovalPolicy } from '../src/approval-policy.ts'
import { EdgeSettings } from '../src/edge-settings.ts'
import { installEdgeMcpServers, type EdgeMcpServerConfig } from '../src/edge-mcp-manager.ts'
import { startMockMcpServer, type MockMcpServer } from './fixtures/mock-mcp-server.mjs'

const MCP_STORAGE_KEY = 'dsh-edge:mcp-servers'

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
    list: () => Promise.resolve(new Map()),
  } as unknown as DurableObjectStorage & { readonly store: Map<string, unknown> }
}

let withResources: MockMcpServer
let withoutResources: MockMcpServer
let resourcesOnly: MockMcpServer

beforeAll(async () => {
  withResources = await startMockMcpServer(0, { resources: true })
  withoutResources = await startMockMcpServer()
  resourcesOnly = await startMockMcpServer(0, { resources: true, tools: false })
})

afterAll(async () => {
  await withResources.close()
  await withoutResources.close()
  await resourcesOnly.close()
})

describe('MCP resource requests', () => {
  it('records the resources capability when probing', async () => {
    expect((await probe('docs', withResources.url)).resources).toBe(true)
    expect((await probe('plain', withoutResources.url)).resources).toBe(false)
    // A resources-only server has an empty tool catalog instead of a failed probe.
    expect(await probe('files', resourcesOnly.url)).toMatchObject({ tools: [], resources: true })
    expect(resourcesOnly.requests).not.toContain('tools/list')
  })

  it('follows list pages without a cursor and returns one page with one', async () => {
    expect(await requestResources(withResources.url, { method: 'resources/list' })).toEqual({
      resources: [
        { uri: 'file:///notes.txt', name: 'notes', mimeType: 'text/plain' },
        { uri: 'file:///logo.png', name: 'logo', mimeType: 'image/png' },
        { uri: 'file:///huge.bin', name: 'huge', mimeType: 'application/octet-stream' },
      ],
    })
    expect(await requestResources(withResources.url, { method: 'resources/list', cursor: 'page-2' })).toMatchObject({
      resources: [{ uri: 'file:///huge.bin' }],
    })
    expect(await requestResources(withResources.url, { method: 'resources/templates/list' })).toEqual({
      resourceTemplates: [{ uriTemplate: 'file:///logs/{day}.txt', name: 'daily log' }],
    })
  })

  it('reads text and binary resources, and refuses one over the response cap', async () => {
    expect(await requestResources(withResources.url, { method: 'resources/read', uri: 'file:///notes.txt' })).toEqual({
      contents: [{ uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'resource notes' }],
    })
    expect(await requestResources(withResources.url, { method: 'resources/read', uri: 'file:///logo.png' })).toMatchObject({
      contents: [{ uri: 'file:///logo.png', mimeType: 'image/png' }],
    })
    await expect(requestResources(withResources.url, { method: 'resources/read', uri: 'file:///huge.bin' }))
      .rejects.toThrow(/larger than 1048576 bytes/u)
  })

  it('fails a response body once it passes the cap, without reading it whole', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(64 * 1024))
      },
    })
    const original = globalThis.fetch
    globalThis.fetch = () => Promise.resolve(new Response(body))
    try {
      const res = await byteCappedFetch(MCP_LIMITS.maxResourceResponseBytes)('http://127.0.0.1/mcp')
      await expect(res.arrayBuffer()).rejects.toThrow(/larger than/u)
      expect(pulled).toBeLessThanOrEqual(MCP_LIMITS.maxResourceResponseBytes / (64 * 1024) + 3)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('MCP resource provider registration', () => {
  async function createCtx(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(McpResourceRuntime)
    return ctx
  }

  it('offers the resource tools while a server with the capability is configured', async () => {
    const storage = createMockStorage()
    const servers: EdgeMcpServerConfig[] = [
      { serverName: 'docs', url: withResources.url, auth: { type: 'none' }, resources: true },
      { serverName: 'plain', url: withoutResources.url, auth: { type: 'none' }, resources: false },
    ]
    storage.store.set(MCP_STORAGE_KEY, servers)
    const ctx = await createCtx()
    const manager = installEdgeMcpServers(ctx, storage)
    await manager.ready
    try {
      const read = ctx.tools.get('read_mcp_resource')
      expect(read).toBeDefined()
      expect(ctx.tools.get('list_mcp_resources')).toBeDefined()
      const exec = { signal: new AbortController().signal }
      const value = await read!.execute({ server: 'docs', uri: 'file:///logo.png' }, exec as never)
      const rendered = read!.output!.render({ server: 'docs' } as never, value as never) as Array<{ text: string }>
      expect(rendered[0]!.text).toMatch(/^MCP server: docs\n/u)
      expect(rendered[0]!.text).toMatch(/\[binary resource: \d+ base64 characters/u)
      await expect(Promise.resolve().then(() => read!.execute({ server: 'plain', uri: 'file:///notes.txt' }, exec as never))).rejects.toThrow(/unavailable/u)
      manager.disposeServer('docs')
      expect(ctx.tools.get('read_mcp_resource')).toBeUndefined()
    } finally {
      manager.disposeAll()
      await ctx.fiber.dispose()
    }
  })

  it('uses the server\'s current settings on each request, not those it was registered with', async () => {
    const storage = createMockStorage()
    storage.store.set(MCP_STORAGE_KEY, [{ serverName: 'docs', url: withResources.url, resources: true }])
    const ctx = await createCtx()
    const manager = installEdgeMcpServers(ctx, storage)
    await manager.ready
    try {
      const read = ctx.tools.get('read_mcp_resource')!
      const exec = { signal: new AbortController().signal } as never
      // A save that keeps the name, URL, and auth type keeps the registration; the next request reads the new entry.
      storage.store.set(MCP_STORAGE_KEY, [{ serverName: 'docs', url: withoutResources.url, resources: true, toolCallTimeoutMs: 5_000 }])
      manager.invalidateConfigCache()
      const before = withoutResources.requests.length
      await expect(Promise.resolve().then(() => read.execute({ server: 'docs', uri: 'file:///notes.txt' }, exec))).rejects.toThrow()
      expect(withoutResources.requests.slice(before)).toContain('resources/read')
      storage.store.set(MCP_STORAGE_KEY, [])
      manager.invalidateConfigCache()
      await expect(Promise.resolve().then(() => read.execute({ server: 'docs', uri: 'file:///notes.txt' }, exec))).rejects.toThrow(/no longer configured/u)
    } finally {
      manager.disposeAll()
      await ctx.fiber.dispose()
    }
  })

  it('records the capability when a server is synced and registers it', async () => {
    const storage = createMockStorage()
    storage.store.set(MCP_STORAGE_KEY, [{ serverName: 'docs', url: withResources.url, auth: { type: 'none' } }])
    const ctx = await createCtx()
    const manager = installEdgeMcpServers(ctx, storage)
    await manager.ready
    try {
      expect(ctx.tools.get('list_mcp_resources')).toBeUndefined()
      await manager.syncServer('docs')
      expect((storage.store.get(MCP_STORAGE_KEY) as EdgeMcpServerConfig[])[0]!.resources).toBe(true)
      expect(ctx.tools.get('list_mcp_resources')).toBeDefined()
      // A second sync replaces the registration instead of colliding with it.
      await manager.syncServer('docs')
      expect(ctx.tools.get('list_mcp_resources')).toBeDefined()
    } finally {
      manager.disposeAll()
      await ctx.fiber.dispose()
    }
  })
})

describe('MCP resource approvals', () => {
  function memoryStorage(): DurableObjectStorage {
    const store = new Map<string, unknown>()
    return {
      get: (key: string) => Promise.resolve(store.get(key)),
      put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
      delete: (key: string) => Promise.resolve(store.delete(key)),
    } as unknown as DurableObjectStorage
  }

  it('asks before a resource call only when its connector asks before every call', async () => {
    const storage = createMockStorage()
    storage.store.set(MCP_STORAGE_KEY, [
      { serverName: 'open', url: withResources.url, resources: true },
      { serverName: 'guarded', url: withResources.url, resources: true, toolPolicy: { mode: 'approve_all' } },
    ] satisfies EdgeMcpServerConfig[])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(EdgeSettings, { storage: memoryStorage() })
    const manager = installEdgeMcpServers(ctx, storage)
    installEdgeApprovalPolicy(ctx, {
      resolveMcpPolicy: name => manager.resolveToolPolicy(name),
      resolveMcpResourcePolicy: server => manager.resolveResourcePolicy(server),
    })
    const preExecute = (ctx as unknown as { waterfall(...args: unknown[]): Promise<unknown> }).waterfall.bind(ctx)
    const decide = (server: string) => preExecute(ctx, 'tools/pre-execute',
      { name: 'read_mcp_resource', arguments: { server, uri: 'file:///notes.txt' } },
      () => Promise.resolve({ kind: 'allow' }))
    try {
      await manager.ready
      expect(await manager.resolveResourcePolicy('open')).toBe('allow')
      expect(await manager.resolveResourcePolicy('guarded')).toBe('ask')
      expect(await manager.resolveResourcePolicy('missing')).toBeUndefined()
      expect(await decide('open')).toEqual({ kind: 'allow' })
      expect(await decide('guarded')).toEqual({ kind: 'ask' })
      expect(await decide('missing')).toEqual({ kind: 'allow' })
    } finally {
      manager.disposeAll()
      await ctx.fiber.dispose()
    }
  })
})
