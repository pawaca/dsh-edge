/** MCP connection manager: registers cached tools at session init, executes calls per-request. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { callTool, probe, type McpAuth, type ProbeResult } from './edge-mcp-client.ts'
import { type CachedMcpTool, mapMcpResultToContentBlocks } from './edge-mcp-tools.ts'

const MCP_STORAGE_KEY = 'dsh-edge:mcp-servers'
const MCP_REFRESH_PREFIX = 'dsh-edge:mcp-refresh:'
const MAX_CATALOG_BYTES = 128 * 1024
const MAX_DESCRIPTION_LENGTH = 512

export interface EdgeMcpServerConfig {
  serverName: string
  url: string
  auth?: { type: 'none' } | { type: 'bearer'; token?: string | undefined } | { type: 'oauth'; endpoints?: unknown; client?: unknown } | undefined
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
  const maxPerTool = MAX_CATALOG_BYTES / 2
  const capped = tools.map(t => {
    const desc = t.description.length > MAX_DESCRIPTION_LENGTH
      ? t.description.slice(0, MAX_DESCRIPTION_LENGTH) + '…'
      : t.description
    const toolJson = JSON.stringify({ ...t, description: desc })
    if (toolJson.length > maxPerTool) {
      return { ...t, description: desc, inputSchema: { type: 'object' } as Record<string, unknown> }
    }
    return { ...t, description: desc }
  })
  const serialized = JSON.stringify(capped)
  if (serialized.length <= MAX_CATALOG_BYTES) return capped
  const ratio = MAX_CATALOG_BYTES / serialized.length
  const limit = Math.max(1, Math.floor(capped.length * ratio))
  return capped.slice(0, limit)
}

function mcpCredentialRefName(serverName: string): string {
  return `MCP_TOKEN_${serverName.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`
}

async function resolveAuth(config: EdgeMcpServerConfig, ctx?: Context, storage?: DurableObjectStorage): Promise<McpAuth> {
  if ((config.auth?.type === 'bearer' || config.auth?.type === 'oauth') && ctx?.credentials !== undefined) {
    // For OAuth, try to refresh expired tokens
    if (config.auth?.type === 'oauth' && storage !== undefined) {
      const refreshData = await storage.get<{
        refreshToken: string
        expiresAt?: number
        tokenEndpoint: string
        client: { clientId: string; clientSecret?: string }
      }>(MCP_REFRESH_PREFIX + config.serverName)
      if (refreshData !== undefined && refreshData.expiresAt !== undefined && Date.now() > refreshData.expiresAt - 120_000) {
        if (!refreshData.refreshToken) {
          console.warn(`dsh-edge: OAuth token expired for "${config.serverName}" and no refresh token is available. Re-authenticate via Settings.`)
          // Mark as needing reauth and withhold the expired token
          const servers = await storage.get<EdgeMcpServerConfig[]>(MCP_STORAGE_KEY) ?? []
          const srv = servers.find(s => s.serverName === config.serverName)
          if (srv !== undefined) { srv.status = 'error'; srv.lastError = 'Token expired. Re-authenticate via Settings.'; await storage.put(MCP_STORAGE_KEY, servers) }
          return { type: 'none' }
        } else try {
          const { refreshToken } = await import('./edge-mcp-oauth.ts')
          const tokens = await refreshToken(refreshData.tokenEndpoint, refreshData.client, refreshData.refreshToken, config.url)
          await ctx.credentials.set(credentialRef(mcpCredentialRefName(config.serverName)), tokens.accessToken)
          if (tokens.refreshToken !== undefined) {
            await storage.put(MCP_REFRESH_PREFIX + config.serverName, {
              ...refreshData,
              refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt,
            })
          } else {
            await storage.put(MCP_REFRESH_PREFIX + config.serverName, { ...refreshData, expiresAt: tokens.expiresAt })
          }
        } catch (e) {
          console.warn(`dsh-edge: OAuth token refresh failed for "${config.serverName}": ${e instanceof Error ? e.message : String(e)}`)
          const servers = await storage.get<EdgeMcpServerConfig[]>(MCP_STORAGE_KEY) ?? []
          const srv = servers.find(s => s.serverName === config.serverName)
          if (srv !== undefined) { srv.status = 'error'; srv.lastError = 'Token refresh failed. Re-authenticate via Settings.'; await storage.put(MCP_STORAGE_KEY, servers) }
          return { type: 'none' }
        }
      }
    }
    const resolved = await ctx.credentials.resolve(credentialRef(mcpCredentialRefName(config.serverName)))
    if (resolved?.value !== undefined) {
      return { type: 'bearer', token: resolved.value }
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
      console.log(`dsh-edge: registering ${server.cachedTools.length} MCP tools for "${server.serverName}"`)
      registerCachedTools(ctx, server, storage)
      console.log(`dsh-edge: registered MCP tools for "${server.serverName}" successfully`)
    } catch (error) {
      console.error(`dsh-edge: failed to register MCP tools for "${server.serverName}".`, error)
    }
  }
}

function registerCachedTools(ctx: Context, server: EdgeMcpServerConfig, storage: DurableObjectStorage): void {
  const tools = server.cachedTools ?? []
  for (const cached of tools) {
    try { ctx.tools.register({
      name: cached.publicName,
      description: cached.description,
      parameters: cached.inputSchema ?? { type: 'object' },
      execute: async (args: Record<string, unknown>, exec: { signal: AbortSignal }) => {
        const auth = await resolveAuth(server, ctx, storage)
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
        schema: { type: 'object', properties: { content: { type: 'array' } }, additionalProperties: true },
        render(_args: unknown, value: unknown): ContentBlock[] {
          const v = value as { content?: unknown[] }
          if (v?.content !== undefined) {
            return mapMcpResultToContentBlocks({ content: v.content as never[], isError: false })
          }
          return [{ type: 'text', text: '(empty MCP result)' }]
        },
      },
    } as never)
    } catch (regError) {
      console.warn(`dsh-edge: skipped MCP tool "${cached.publicName}": ${regError instanceof Error ? regError.message : String(regError)}`)
    }
  }
}


export async function probeAndCache(
  storage: DurableObjectStorage,
  serverName: string,
  ctx?: Context,
): Promise<ProbeResult> {
  const servers = await storage.get<EdgeMcpServerConfig[]>(MCP_STORAGE_KEY) ?? []
  const server = servers.find(s => s.serverName === serverName)
  if (server === undefined) throw new Error(`Server "${serverName}" not found.`)

  const auth = await resolveAuth(server, ctx, storage)
  const url = server.url
  let result: ProbeResult
  try {
    result = await probe(serverName, url, auth)
  } catch (error) {
    const fresh = await storage.get<EdgeMcpServerConfig[]>(MCP_STORAGE_KEY) ?? []
    const entry = fresh.find(s => s.serverName === serverName)
    if (entry !== undefined && entry.url === url) {
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
