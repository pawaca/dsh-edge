/** Edge MCP client: config-time probe and per-call tool execution via SDK @1.30. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  type CachedMcpTool,
  type McpCallResult,
  publicToolName,
  scrubMcpErrorMessage,
} from './edge-mcp-tools.ts'
import { DSH_EDGE_VERSION } from './release.ts'

const PROBE_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 60_000
const MAX_TOOLS_PER_SERVER = 128
const MAX_CATALOG_PAGES = 10

export interface ProbeResult {
  tools: CachedMcpTool[]
  serverInfo?: { name?: string | undefined; version?: string | undefined } | undefined
  instructions?: string | undefined
}

export interface McpAuth {
  type: 'none' | 'bearer'
  token?: string | undefined
}

function buildHeaders(auth?: McpAuth): Record<string, string> {
  if (auth?.type === 'bearer' && auth.token !== undefined) {
    return { Authorization: `Bearer ${auth.token}` }
  }
  return {}
}

async function connectClient(
  url: string,
  auth: McpAuth | undefined,
  signal: AbortSignal,
) {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    { requestInit: { headers: buildHeaders(auth), signal } },
  )
  const client = new Client({ name: 'dsh-edge', version: DSH_EDGE_VERSION })
  await client.connect(transport as never)
  return {
    client,
    close: async () => { await client.close().catch(() => undefined) },
  }
}

export async function probe(
  serverName: string,
  url: string,
  auth?: McpAuth,
): Promise<ProbeResult> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  let conn: Awaited<ReturnType<typeof connectClient>>
  try {
    conn = await connectClient(url, auth, signal)
  } catch (error) {
    throw new Error(scrubMcpErrorMessage(error instanceof Error ? error.message : String(error)))
  }
  const { client, close } = conn
  try {
    const tools: CachedMcpTool[] = []
    const seenNames = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
      const result = await client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal },
      )
      for (const tool of result.tools) {
        if (tools.length >= MAX_TOOLS_PER_SERVER) break
        const publicName = publicToolName(serverName, tool.name)
        if (seenNames.has(publicName)) {
          throw new Error(`Server listed tool "${tool.name}" more than once`)
        }
        seenNames.add(publicName)
        tools.push({
          name: tool.name,
          publicName,
          description: tool.description ?? '',
          inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
        })
      }
      if (tools.length >= MAX_TOOLS_PER_SERVER) break
      cursor = result.nextCursor ?? undefined
      if (cursor === undefined) break
      if (seenCursors.has(cursor)) {
        throw new Error(`Server repeated a tools/list continuation cursor`)
      }
      seenCursors.add(cursor)
    }

    const serverVersion = client.getServerVersion?.()
    const instructions = client.getInstructions?.()

    return {
      tools,
      serverInfo: serverVersion
        ? { name: serverVersion.name, version: serverVersion.version }
        : undefined,
      instructions: typeof instructions === 'string' && instructions.length > 0
        ? instructions.slice(0, 1024)
        : undefined,
    }
  } finally {
    await close()
  }
}

export async function callTool(
  url: string,
  rawToolName: string,
  args: unknown,
  auth?: McpAuth,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<McpCallResult> {
  const effectiveTimeout = timeoutMs ?? CALL_TIMEOUT_MS
  const deadline = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(effectiveTimeout)])
    : AbortSignal.timeout(effectiveTimeout)
  let client: Awaited<ReturnType<typeof connectClient>>
  try {
    client = await connectClient(url, auth, deadline)
  } catch (error) {
    throw new Error(scrubMcpErrorMessage(error instanceof Error ? error.message : String(error)))
  }
  try {
    const result = await client.client.callTool(
      { name: rawToolName, arguments: args as Record<string, unknown> },
      undefined,
      { signal: deadline },
    )
    return {
      content: (result.content ?? []) as McpCallResult['content'],
      isError: result.isError === true,
    }
  } catch (error) {
    throw new Error(scrubMcpErrorMessage(error instanceof Error ? error.message : String(error)))
  } finally {
    await client.close()
  }
}
