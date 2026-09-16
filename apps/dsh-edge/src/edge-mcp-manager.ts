/** MCP connection manager: registers cached tools at session init, executes calls per-request. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { callTool, probe, type McpAuth, type ProbeResult } from './edge-mcp-client.ts'
import { type CachedMcpTool, mapMcpResultToContentBlocks } from './edge-mcp-tools.ts'

const MCP_STORAGE_KEY = 'dsh-edge:mcp-servers'

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
    if (!Array.isArray(server.cachedTools) || server.cachedTools.length === 0) continue
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
          ([k, v]) => [k, v as Record<string, unknown>],
        ),
      ),
      execute: async (args: Record<string, unknown>, exec: { signal: AbortSignal }) => {
        const auth = authFromConfig(server)
        const result = await callTool(server.url, cached.name, args, auth, exec.signal)
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
  try {
    const result = await probe(serverName, server.url, auth)
    server.cachedTools = result.tools
    server.status = 'connected'
    server.toolCount = result.tools.length
    server.lastProbeAt = Date.now()
    server.serverInfo = result.serverInfo
    server.instructions = result.instructions
    delete server.lastError
    await storage.put(MCP_STORAGE_KEY, servers)
    return result
  } catch (error) {
    server.status = 'error'
    server.lastError = error instanceof Error ? error.message : String(error)
    server.lastProbeAt = Date.now()
    await storage.put(MCP_STORAGE_KEY, servers)
    throw error
  }
}
