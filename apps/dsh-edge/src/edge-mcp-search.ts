/** MCP meta-tools: mcp_search + mcp_call for indirect tool discovery and execution. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { callTool, type McpAuth } from './edge-mcp-client.ts'
import type { CachedMcpTool, McpContentBlock } from './edge-mcp-tools.ts'
import { mapMcpResultToContentBlocks, scrubMcpErrorMessage } from './edge-mcp-tools.ts'
import type { EdgeMcpServerConfig, McpToolMeta } from './edge-mcp-manager.ts'

const SEARCH_DEFAULT_LIMIT = 5
const SEARCH_MAX_OUTPUT_BYTES = 24 * 1024

interface SearchableEntry {
  serverName: string
  tool: CachedMcpTool
}

function scoreMatch(entry: SearchableEntry, keywords: string[]): number {
  let score = 0
  const nameLower = entry.tool.name.toLowerCase()
  const descLower = (entry.tool.description ?? '').toLowerCase()
  const serverLower = entry.serverName.toLowerCase()
  const paramNames = Object.keys((entry.tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).join(' ').toLowerCase()

  for (const kw of keywords) {
    if (nameLower === kw) score += 20
    else if (nameLower.includes(kw)) score += 10
    if (serverLower.includes(kw)) score += 5
    if (paramNames.includes(kw)) score += 3
    if (descLower.includes(kw)) score += 1
  }
  return score
}

function renderCompactDeclaration(schema: Record<string, unknown>): string {
  const props = schema.properties as Record<string, { type?: string; description?: string }> | undefined
  if (props === undefined || Object.keys(props).length === 0) return '{}'
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : [])
  const fields = Object.entries(props).map(([name, spec]) => {
    const type = typeof spec?.type === 'string' ? spec.type : 'unknown'
    const opt = required.has(name) ? '' : '?'
    return `${name}${opt}: ${type}`
  })
  return `{ ${fields.join('; ')} }`
}

function sanitizeInstructions(text: string): string {
  return text.replace(/[\n\r]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 200)
}

export function buildServerSummary(servers: EdgeMcpServerConfig[]): string | undefined {
  const connected = servers.filter(s => s.status === 'connected' && (s.toolCount ?? 0) > 0)
  if (connected.length === 0) return undefined
  const lines = connected.map(s => {
    const count = s.toolCount ?? 0
    const raw = s.instructions ?? s.serverInfo?.name ?? ''
    const desc = raw ? sanitizeInstructions(raw) : ''
    return desc ? `- ${s.serverName} (${count} tools): ${desc}` : `- ${s.serverName} (${count} tools)`
  })
  return `Connected MCP servers (use mcp_search to discover tools, mcp_call to invoke them):\n${lines.join('\n')}`
}

interface McpSearchInput {
  query: string
  serverName?: string
  limit?: number
}

function executeSearch(
  input: McpSearchInput,
  servers: EdgeMcpServerConfig[],
): string {
  const keywords = input.query.toLowerCase().split(/\s+/u).filter(k => k.length > 0)
  if (keywords.length === 0) return JSON.stringify({ tools: [], note: 'Empty query.' })

  const entries: SearchableEntry[] = []
  for (const server of servers) {
    if (server.status !== 'connected' || !Array.isArray(server.cachedTools)) continue
    if (input.serverName !== undefined && server.serverName !== input.serverName) continue
    for (const tool of server.cachedTools) {
      entries.push({ serverName: server.serverName, tool })
    }
  }

  const scored = entries
    .map(e => ({ entry: e, score: scoreMatch(e, keywords) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)

  const limit = Math.min(input.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_DEFAULT_LIMIT)
  const selected = scored.slice(0, limit)

  const results = selected.map(({ entry, score }) => ({
    serverName: entry.serverName,
    toolName: entry.tool.publicName,
    name: entry.tool.name,
    description: entry.tool.description.slice(0, 200),
    score,
    inputDeclaration: renderCompactDeclaration(entry.tool.inputSchema),
  }))

  let output = JSON.stringify({ tools: results, totalAvailable: entries.length })
  while (results.length > 1 && new TextEncoder().encode(output).byteLength > SEARCH_MAX_OUTPUT_BYTES) {
    results.pop()
    output = JSON.stringify({ tools: results, totalAvailable: entries.length })
  }
  return output
}

export function registerMetaTools(
  ctx: Context,
  toolMeta: Map<string, McpToolMeta>,
  resolveAuth: (config: EdgeMcpServerConfig) => Promise<McpAuth>,
  getServers: () => Promise<EdgeMcpServerConfig[]>,
): Map<string, () => void> {
  const disposers = new Map<string, () => void>()

  try {
    const searchDispose = ctx.tools.register({
      name: 'mcp_search',
      description: 'Search for MCP tools by keyword across all connected servers. '
        + 'Returns tool names, descriptions, and compact parameter declarations. '
        + 'Always search first — mcp_call only accepts tools discovered here.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to match against tool names, descriptions, and parameters. Use server name + action for best results (e.g. "futu stock quote", "github create issue").' },
          serverName: { type: 'string', description: 'Restrict search to one server name (optional).' },
          limit: { type: 'number', description: 'Max results (1-5, default 5).' },
        },
        required: ['query'],
      },
      execute: async (args: Record<string, unknown>) => {
        const servers = await getServers()
        const result = executeSearch(args as unknown as McpSearchInput, servers)
        return { content: [{ type: 'text', text: result }] }
      },
      output: {
        schema: { type: 'object', properties: { content: { type: 'array' } }, additionalProperties: true },
        render(_args: unknown, value: unknown): ContentBlock[] {
          const v = value as { content?: McpContentBlock[] }
          if (v?.content?.[0]?.type === 'text' && v.content[0].text !== undefined) {
            return [{ type: 'text', text: v.content[0].text }]
          }
          return [{ type: 'text', text: '(no search results)' }]
        },
      },
    } as never) as () => void
    disposers.set('mcp_search', searchDispose)
  } catch (e) {
    console.warn(`dsh-edge: failed to register mcp_search: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const callDispose = ctx.tools.register({
      name: 'mcp_call',
      description: 'Call an MCP tool discovered via mcp_search. '
        + 'Use the exact toolName from search results. '
        + 'Arguments are passed directly to the MCP server. '
        + 'On argument errors, fix the arguments and retry without re-searching. '
        + 'On "tool not found", run mcp_search first to discover available tools.',
      parameters: {
        type: 'object',
        properties: {
          toolName: { type: 'string', description: 'Qualified tool name from mcp_search results (e.g. "mcp__futu__get_stock_quote").' },
          arguments: { type: 'object', description: 'Arguments matching the tool\'s inputDeclaration from search results.', additionalProperties: true },
        },
        required: ['toolName'],
      },
      execute: async (args: Record<string, unknown>, exec: { signal: AbortSignal }) => {
        const toolName = args.toolName as string
        if (typeof toolName !== 'string' || toolName === '') {
          throw new Error('toolName is required. Use mcp_search to discover available tools.')
        }

        const meta = toolMeta.get(toolName)
        if (meta === undefined) {
          throw new Error(`Tool "${toolName}" not found. Use mcp_search to discover available tools, then use the exact toolName from the results.`)
        }

        const servers = await getServers()
        const server = servers.find(s => s.serverName === meta.serverName)
        if (server === undefined) {
          throw new Error(`Server "${meta.serverName}" is no longer available.`)
        }

        let toolArgs = args.arguments as Record<string, unknown> | undefined
        if (toolArgs === null || toolArgs === undefined) toolArgs = {}
        if (typeof toolArgs === 'string') {
          try { toolArgs = JSON.parse(toolArgs) as Record<string, unknown> } catch {
            throw new Error('arguments must be a JSON object. Check the inputDeclaration from mcp_search and try again.')
          }
        }

        const auth = await resolveAuth(server)
        const result = await callTool(server.url, meta.rawName, toolArgs, auth, exec.signal, server.toolCallTimeoutMs)

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
        return value
      },
      output: {
        schema: { type: 'object', properties: { content: { type: 'array' } }, additionalProperties: true },
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
    } as never) as () => void
    disposers.set('mcp_call', callDispose)
  } catch (e) {
    console.warn(`dsh-edge: failed to register mcp_call: ${e instanceof Error ? e.message : String(e)}`)
  }

  return disposers
}
