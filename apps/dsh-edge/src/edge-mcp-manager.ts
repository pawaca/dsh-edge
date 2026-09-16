/** MCP connection manager: registers cached tools at session init, executes calls per-request. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { callTool, probe, type McpAuth, type ProbeResult } from './edge-mcp-client.ts'
import { type CachedMcpTool, mapMcpResultToContentBlocks } from './edge-mcp-tools.ts'

const MCP_STORAGE_KEY = 'dsh-edge:mcp-servers'
const MAX_CATALOG_BYTES = 128 * 1024
const MAX_DESCRIPTION_LENGTH = 512

export interface EdgeMcpServerConfig {
  serverName: string
  url: string
  auth?: { type: 'none' } | { type: 'bearer'; token?: string | undefined } | undefined
  toolCallTimeoutMs?: number | undefined
  cachedTools?: CachedMcpTool[] | undefined
  status?: 'unknown' | 'connected' | 'error' | undefined
  toolCount?: number | undefined
  lastProbeAt?: number | undefined
  serverInfo?: { name?: string | undefined; version?: string | undefined } | undefined
  instructions?: string | undefined
  lastError?: string | undefined
}

function capCatalogSize(tools: CachedMcpTool[]): CachedMcpTool[] {
  const capped = tools.map(t => ({
    ...t,
    description: t.description.length > MAX_DESCRIPTION_LENGTH
      ? t.description.slice(0, MAX_DESCRIPTION_LENGTH) + '…'
      : t.description,
  }))
  const serialized = JSON.stringify(capped)
  if (serialized.length <= MAX_CATALOG_BYTES) return capped
  const ratio = MAX_CATALOG_BYTES / serialized.length
  const limit = Math.max(1, Math.floor(capped.length * ratio))
  return capped.slice(0, limit)
}

function authFromConfig(config: EdgeMcpServerConfig): McpAuth {
  if (config.auth?.type === 'bearer') {
    const bearerAuth = config.auth as { token?: string | undefined }
    if (bearerAuth.token !== undefined) {
      return { type: 'bearer', token: bearerAuth.token }
    }
  }
  return { type: 'none' }
}

export async function installEdgeMcpServers(
  ctx: Context,
  storage: DurableObjectStorage,
): Promise<void> {
  const raw = await storage.get<EdgeMcpServerConfig[]>(MCP_STORAGE_KEY)
  if (!Array.isArray(raw) || raw.length === 0) return

  for (const server of raw) {
    if (!Array.isArray(server.cachedTools) || server.cachedTools.length === 0) {
      if (server.cachedTools === undefined) {
        console.log(`dsh-edge: MCP server "${server.serverName}" has no cached tools. Use POST /api/mcp-servers/${server.serverName}/probe to discover tools.`)
      }
      continue
    }
    try {
      registerCachedTools(ctx, server)
    } catch (error) {
      console.error(`dsh-edge: failed to register MCP tools for "${server.serverName}".`, error)
    }
  }
}

function registerCachedTools(ctx: Context, server: EdgeMcpServerConfig): void {
  const tools = server.cachedTools ?? []
  for (const cached of tools) {
    ctx.tools.register({
      name: cached.publicName,
      description: cached.description,
      parameters: Object.fromEntries(
        Object.entries(cached.inputSchema.properties ?? {}).map(
          ([k, v]) => {
            const spec = v as Record<string, unknown>
            const requiredList = cached.inputSchema.required
            const isRequired = Array.isArray(requiredList) && requiredList.includes(k)
            return [k, isRequired ? { ...spec, required: true } : spec]
          },
        ),
      ),
      execute: async (args: Record<string, unknown>, exec: { signal: AbortSignal }) => {
        const auth = authFromConfig(server)
        const result = await callTool(server.url, cached.name, args, auth, exec.signal, server.toolCallTimeoutMs)
        if (result.isError) {
          const text = result.content
            .filter(b => b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text!)
            .join('\n')
          throw new Error(text || 'MCP tool returned an error.')
        }
        return { content: result.content }
      },
      output: {
        render(_args: unknown, value: unknown): ContentBlock[] {
          const v = value as { content?: unknown[] }
          if (v?.content !== undefined) {
            return mapMcpResultToContentBlocks({ content: v.content as never[], isError: false })
          }
          return [{ type: 'text', text: '(empty MCP result)' }]
        },
      },
    } as never)
  }
}

export async function probeAndCache(
  storage: DurableObjectStorage,
  serverName: string,
): Promise<ProbeResult> {
  const servers = await storage.get<EdgeMcpServerConfig[]>(MCP_STORAGE_KEY) ?? []
  const server = servers.find(s => s.serverName === serverName)
  if (server === undefined) throw new Error(`Server "${serverName}" not found.`)

  const auth = authFromConfig(server)
  const url = server.url
  let result: ProbeResult
  try {
    result = await probe(serverName, url, auth)
  } catch (error) {
    const fresh = await storage.get<EdgeMcpServerConfig[]>(MCP_STORAGE_KEY) ?? []
    const entry = fresh.find(s => s.serverName === serverName)
    if (entry !== undefined) {
      entry.status = 'error'
      entry.lastError = error instanceof Error ? error.message : String(error)
      entry.lastProbeAt = Date.now()
      await storage.put(MCP_STORAGE_KEY, fresh)
    }
    throw error
  }
  const fresh = await storage.get<EdgeMcpServerConfig[]>(MCP_STORAGE_KEY) ?? []
  const entry = fresh.find(s => s.serverName === serverName)
  if (entry !== undefined && entry.url === url) {
    const capped = capCatalogSize(result.tools)
    entry.cachedTools = capped
    entry.status = 'connected'
    entry.toolCount = capped.length
    entry.lastProbeAt = Date.now()
    entry.serverInfo = result.serverInfo
    entry.instructions = result.instructions
    delete entry.lastError
    await storage.put(MCP_STORAGE_KEY, fresh)
  }
  return result
}
