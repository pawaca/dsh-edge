/** MCP connection manager: registers cached tools at session init, hot-swaps on probe. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import { callTool, probe, type McpAuth, type ProbeResult } from './edge-mcp-client.ts'
import {
  type CachedMcpTool,
  type McpContentBlock,
  type McpToolPolicyMode,
  containsImage,
  decodeImageBlock,
  evaluateMcpToolPolicy,
  mapMcpResultToContentBlocks,
  scrubMcpErrorMessage,
} from './edge-mcp-tools.ts'
import { MCP_LIMITS } from './edge-mcp-limits.ts'

const MCP_STORAGE_KEY = 'dsh-edge:mcp-servers'
const MCP_REFRESH_PREFIX = 'dsh-edge:mcp-refresh:'

export interface EdgeMcpServerConfig {
  serverName: string
  url: string
  auth?: { type: 'none' } | { type: 'bearer'; token?: string | undefined } | { type: 'oauth'; endpoints?: unknown; client?: unknown } | undefined
  toolPolicy?: { mode: McpToolPolicyMode } | undefined
  toolCallTimeoutMs?: number | undefined
  cachedTools?: CachedMcpTool[] | undefined
  status?: 'unknown' | 'connected' | 'error' | undefined
  toolCount?: number | undefined
  lastProbeAt?: number | undefined
  serverInfo?: { name?: string | undefined; version?: string | undefined } | undefined
  instructions?: string | undefined
  lastError?: string | undefined
}

export interface McpToolMeta {
  serverName: string
  rawName: string
  readOnlyHint?: boolean | undefined
}

export interface McpToolManager {
  ready: Promise<void>
  syncServer(serverName: string): Promise<ProbeResult>
  disposeServer(serverName: string): void
  disposeAll(): void
  resolveToolPolicy(publicName: string): Promise<'allow' | 'ask' | undefined>
}

function capCatalogSize(tools: CachedMcpTool[]): CachedMcpTool[] {
  const maxPerTool = MCP_LIMITS.maxCatalogBytes / 2
  const capped = tools.map(t => {
    const desc = t.description.length > MCP_LIMITS.maxDescriptionLength
      ? t.description.slice(0, MCP_LIMITS.maxDescriptionLength) + '…'
      : t.description
    const toolJson = JSON.stringify({ ...t, description: desc })
    if (toolJson.length > maxPerTool) {
      return { ...t, description: desc, inputSchema: { type: 'object' } as Record<string, unknown>, outputSchema: undefined }
    }
    return { ...t, description: desc }
  })
  const serialized = JSON.stringify(capped)
  if (serialized.length <= MCP_LIMITS.maxCatalogBytes) return capped
  const ratio = MCP_LIMITS.maxCatalogBytes / serialized.length
  const limit = Math.max(1, Math.floor(capped.length * ratio))
  return capped.slice(0, limit)
}

function mcpCredentialRefName(serverName: string): string {
  return `MCP_TOKEN_${serverName.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`
}

async function resolveAuth(config: EdgeMcpServerConfig, ctx?: Context, storage?: DurableObjectStorage): Promise<McpAuth> {
  if ((config.auth?.type === 'bearer' || config.auth?.type === 'oauth') && ctx?.credentials !== undefined) {
    if (config.auth?.type === 'oauth' && storage !== undefined) {
      const refreshData = await storage.get<{
        refreshToken: string
        expiresAt?: number
        tokenEndpoint: string
        client: { clientId: string; clientSecret?: string }
      }>(MCP_REFRESH_PREFIX + config.serverName)
      if (refreshData !== undefined && refreshData.expiresAt !== undefined && Date.now() > refreshData.expiresAt - 120_000) {
        if (!refreshData.refreshToken) {
          console.warn(`dsh-edge: OAuth token expired for "${config.serverName}" and no refresh token is available.`)
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
          console.warn(`dsh-edge: OAuth token refresh failed for "${config.serverName}": ${scrubMcpErrorMessage(e instanceof Error ? e.message : String(e))}`)
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

function buildOutputSchema(outputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  const props: Record<string, unknown> = { content: { type: 'array' } }
  const required = ['content']
  if (outputSchema !== undefined) {
    props['structuredContent'] = outputSchema
    required.push('structuredContent')
  } else {
    props['structuredContent'] = {}
  }
  return { type: 'object', properties: props, required, additionalProperties: false }
}

function imageDiagnostic(block: McpContentBlock, reason: string): string {
  return `[image unavailable: ${block.mimeType ?? 'unknown media type'}; ${reason}]`
}

async function tryProjectImages(
  ctx: Context,
  exec: { signal: AbortSignal; agent?: { session: { requestHeader(): { config?: { provider?: string; model?: string } } | undefined }; options: { provider?: string; model?: string } } },
  content: McpContentBlock[],
): Promise<ContentBlock[] | undefined> {
  const attachments = ctx.get('attachments') as AttachmentStore | undefined
  if (attachments === undefined) return undefined

  const llm = ctx.get('llm') as { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: string[] }> } | undefined
  if (llm === undefined) return undefined

  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (provider === undefined || model === undefined) return undefined

  let info: { inputModalities?: string[] }
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    return undefined
  }
  if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) return undefined

  const decoded: SaveImageAttachment[] = []
  const imageIndexes: number[] = []
  for (const [index, block] of content.entries()) {
    if (block.type !== 'image') continue
    const img = decodeImageBlock(block)
    if (img === undefined) {
      return projectContentWithImageFallback(content, (b) => imageDiagnostic(b, 'invalid image data'))
    }
    decoded.push({ data: img.data, mediaType: img.mediaType as 'image/png' })
    imageIndexes.push(index)
  }

  if (decoded.length === 0) return undefined

  try {
    const refs = await attachments.saveImages(decoded) as readonly ImageAttachmentRef[]
    const refByIndex = new Map(imageIndexes.map((idx, offset) => [idx, refs[offset]]))
    const projected: ContentBlock[] = []
    const textParts: string[] = []
    const flushText = () => {
      if (textParts.length === 0) return
      projected.push({ type: 'text', text: textParts.splice(0).join('\n') })
    }
    for (const [index, block] of content.entries()) {
      if (block.type === 'image' && refByIndex.has(index)) {
        flushText()
        projected.push({ type: 'image', attachment: refByIndex.get(index) } as never)
      } else if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text)
      } else {
        textParts.push(mapSingleBlockToText(block))
      }
    }
    flushText()
    return projected.length > 0 ? projected : undefined
  } catch (error) {
    const reason = isImageAdmissionError(error) ? `image admission rejected: ${(error as Error).message}` : 'durable image storage failed'
    return projectContentWithImageFallback(content, (b) => imageDiagnostic(b, reason))
  }
}

function projectContentWithImageFallback(
  content: McpContentBlock[],
  fallback: (block: McpContentBlock) => string,
): ContentBlock[] {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'image') {
      parts.push(fallback(block))
    } else if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else {
      parts.push(mapSingleBlockToText(block))
    }
  }
  return parts.length > 0 ? [{ type: 'text', text: parts.join('\n') }] : [{ type: 'text', text: '(empty MCP result)' }]
}

function mapSingleBlockToText(block: McpContentBlock): string {
  if (block.type === 'resource_link' && block.uri !== undefined) return `Resource: ${block.name ?? 'unnamed'} (${block.uri})`
  if (block.type === 'audio') return '[audio result unsupported on Cloudflare Workers]'
  if (block.type === 'resource' && block.resource?.text !== undefined) return `--- ${block.resource.uri ?? 'embedded resource'} ---\n${block.resource.text}`
  if (block.type === 'resource') return '[embedded resource: binary content not displayed]'
  return `[unsupported MCP content type: ${block.type}]`
}

function registerCachedTools(
  ctx: Context,
  server: EdgeMcpServerConfig,
  storage: DurableObjectStorage,
  toolMeta: Map<string, McpToolMeta>,
): Map<string, () => void> {
  const disposers = new Map<string, () => void>()
  const tools = server.cachedTools ?? []
  for (const cached of tools) {
    const imageProjections = new WeakMap<object, { value: unknown; fallback: ContentBlock[]; content: ContentBlock[] }>()
    try {
      const outputSchema = buildOutputSchema(cached.outputSchema)
      const dispose = ctx.tools.register({
        name: cached.publicName,
        description: cached.description,
        parameters: cached.inputSchema ?? { type: 'object' },
        execute: async (args: Record<string, unknown>, exec: { signal: AbortSignal; agent?: unknown }) => {
          const auth = await resolveAuth(server, ctx, storage)
          const result = await callTool(server.url, cached.name, args, auth, exec.signal, server.toolCallTimeoutMs)
          if (result.isError) {
            const text = result.content
              .filter(b => b.type === 'text' && typeof b.text === 'string')
              .map(b => b.text!)
              .join('\n')
            throw new Error(scrubMcpErrorMessage(text || 'MCP tool returned an error.'))
          }
          const value: Record<string, unknown> = { content: result.content }
          if (result.structuredContent !== undefined) {
            value['structuredContent'] = result.structuredContent
          }
          if (containsImage(result.content)) {
            try {
              const projected = await tryProjectImages(ctx, exec as never, result.content)
              if (projected !== undefined) {
                const fallback = mapMcpResultToContentBlocks({ content: result.content, isError: false })
                imageProjections.set(exec, { value, fallback, content: projected })
              }
            } catch { /* image projection is best-effort */ }
          }
          return value
        },
        output: {
          schema: outputSchema,
          render(_args: unknown, value: unknown): ContentBlock[] {
            const v = value as { content?: McpContentBlock[]; structuredContent?: unknown }
            if (v?.content !== undefined && v.content.length > 0) {
              return mapMcpResultToContentBlocks({ content: v.content, isError: false })
            }
            if (v?.structuredContent !== undefined) {
              return [{ type: 'text', text: JSON.stringify(v.structuredContent, null, 2) }]
            }
            return [{ type: 'text', text: '(empty MCP result)' }]
          },
        },
        finalizeContent(exec: Readonly<{ signal: AbortSignal }>, result: Readonly<{ isError?: boolean; value?: unknown; content?: ContentBlock[] }>) {
          const projection = imageProjections.get(exec)
          if (projection === undefined) return undefined
          imageProjections.delete(exec)
          if (result.isError) return undefined
          return projection.content
        },
      } as never) as () => void
      disposers.set(cached.publicName, dispose)
      toolMeta.set(cached.publicName, {
        serverName: server.serverName,
        rawName: cached.name,
        readOnlyHint: cached.annotations?.readOnlyHint,
      })
    } catch (regError) {
      console.warn(`dsh-edge: skipped MCP tool "${cached.publicName}": ${regError instanceof Error ? regError.message : String(regError)}`)
    }
  }
  return disposers
}

export function installEdgeMcpServers(
  ctx: Context,
  storage: DurableObjectStorage,
): McpToolManager {
  const serverDisposers = new Map<string, Map<string, () => void>>()
  const toolMeta = new Map<string, McpToolMeta>()
  let syncChain = Promise.resolve()

  const raw = storage.get<EdgeMcpServerConfig[]>(MCP_STORAGE_KEY)

  const initPromise = raw.then(servers => {
    if (!Array.isArray(servers) || servers.length === 0) return
    for (const server of servers) {
      if (!Array.isArray(server.cachedTools) || server.cachedTools.length === 0) {
        if (server.cachedTools === undefined) {
          console.log(`dsh-edge: MCP server "${server.serverName}" has no cached tools. Use POST /api/mcp-servers/${server.serverName}/probe to discover tools.`)
        }
        continue
      }
      try {
        console.log(`dsh-edge: registering ${server.cachedTools.length} MCP tools for "${server.serverName}"`)
        const disposers = registerCachedTools(ctx, server, storage, toolMeta)
        serverDisposers.set(server.serverName, disposers)
        console.log(`dsh-edge: registered MCP tools for "${server.serverName}" successfully`)
      } catch (error) {
        console.error(`dsh-edge: failed to register MCP tools for "${server.serverName}".`, error)
      }
    }
  })

  function disposeServer(serverName: string): void {
    const disposers = serverDisposers.get(serverName)
    if (disposers !== undefined) {
      for (const [publicName, dispose] of disposers) {
        dispose()
        toolMeta.delete(publicName)
      }
      serverDisposers.delete(serverName)
    }
  }

  async function syncServer(serverName: string): Promise<ProbeResult> {
    await initPromise
    const run = syncChain.then(async () => {
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
          entry.lastError = scrubMcpErrorMessage(error instanceof Error ? error.message : String(error))
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

        disposeServer(serverName)
        const disposers = registerCachedTools(ctx, entry, storage, toolMeta)
        serverDisposers.set(serverName, disposers)
        console.log(`dsh-edge: hot-swapped ${disposers.size} MCP tools for "${serverName}"`)
      }
      return result
    })
    syncChain = run.then(() => {}, () => {})
    return run
  }

  async function resolveToolPolicy(publicName: string): Promise<'allow' | 'ask' | undefined> {
    await initPromise
    const meta = toolMeta.get(publicName)
    if (meta === undefined) return undefined
    const servers = await storage.get<EdgeMcpServerConfig[]>(MCP_STORAGE_KEY) ?? []
    const server = servers.find(s => s.serverName === meta.serverName)
    return evaluateMcpToolPolicy(meta.rawName, server?.toolPolicy?.mode, meta.readOnlyHint)
  }

  return {
    ready: initPromise,
    syncServer,
    disposeServer,
    resolveToolPolicy,
    disposeAll() {
      for (const [, disposers] of serverDisposers) {
        for (const dispose of disposers.values()) dispose()
      }
      toolMeta.clear()
      serverDisposers.clear()
    },
  }
}
