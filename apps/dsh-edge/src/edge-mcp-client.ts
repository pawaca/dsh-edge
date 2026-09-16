/** Edge MCP client: config-time probe and per-call tool execution via SDK @1.30. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
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

const BLOCKED_HOSTNAME_SUFFIXES = ['.internal', '.local', '.localhost']

const PRIVATE_IPV4_PATTERNS = [
  /^127\./u,
  /^10\./u,
  /^172\.(1[6-9]|2\d|3[01])\./u,
  /^192\.168\./u,
  /^0\./u,
  /^169\.254\./u,
]

const PRIVATE_IPV6_PATTERNS = [
  /^::1$/u,
  /^fc/iu,
  /^fd/iu,
  /^fe80:/iu,
]

function isIpAddress(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/u.test(hostname) || hostname.includes(':')
}

export function assertSafeUrl(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MCP server URL must use http: or https: protocol.')
  }
  const raw = parsed.hostname.toLowerCase()
  // Strip IPv6 brackets: [fc00::1] → fc00::1
  const hostname = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return // allow localhost for development
  }
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      throw new Error(`MCP server hostname "${hostname}" is blocked.`)
    }
  }
  if (isIpAddress(hostname)) {
    for (const pattern of PRIVATE_IPV4_PATTERNS) {
      if (pattern.test(hostname)) {
        throw new Error(`MCP server address "${hostname}" is a private IP and is blocked.`)
      }
    }
    for (const pattern of PRIVATE_IPV6_PATTERNS) {
      if (pattern.test(hostname)) {
        throw new Error(`MCP server address "${hostname}" is a private IP and is blocked.`)
      }
    }
  }
}

function buildHeaders(auth?: McpAuth): Record<string, string> {
  if (auth?.type === 'bearer' && auth.token !== undefined) {
    return { Authorization: `Bearer ${auth.token}` }
  }
  return {}
}

const cfWorkerValidator = new CfWorkerJsonSchemaValidator()

const noRedirectFetch: typeof globalThis.fetch = async (input, init) => {
  const res = await globalThis.fetch(input, { ...init, redirect: 'manual' })
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') ?? '(unknown)'
    throw new Error(`MCP server returned a redirect to ${location}; redirects are blocked for security.`)
  }
  return res
}

async function connectClient(
  url: string,
  auth: McpAuth | undefined,
  signal: AbortSignal,
) {
  assertSafeUrl(url)
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    { requestInit: { headers: buildHeaders(auth), signal }, fetch: noRedirectFetch },
  )
  const client = new Client(
    { name: 'dsh-edge', version: DSH_EDGE_VERSION },
    { capabilities: {}, jsonSchemaValidator: cfWorkerValidator },
  )
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
        const hint = (tool as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint
        tools.push({
          name: tool.name,
          publicName,
          description: tool.description ?? '',
          inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
          ...(hint !== undefined ? { annotations: { readOnlyHint: hint } } : {}),
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
