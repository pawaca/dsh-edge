/** Edge MCP client: config-time probe and per-call tool execution via SDK @1.30. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import {
  type CachedMcpTool,
  type McpCallResult,
  publicToolName,
  scrubMcpErrorMessage,
  supportedOutputSchema,
} from './edge-mcp-tools.ts'
import { MCP_LIMITS } from './edge-mcp-limits.ts'
import { DSH_EDGE_VERSION } from './release.ts'

export interface ProbeResult {
  tools: CachedMcpTool[]
  serverInfo?: { name?: string | undefined; version?: string | undefined } | undefined
  instructions?: string | undefined
  /** Whether the server declared the `resources` capability. */
  resources: boolean
}

/** One resources/* operation, as `dsh-mcp-resources` forwards it. */
export type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string }

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
  /^fe[89ab][0-9a-f]:/iu,
]

function extractMappedIPv4(hostname: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(hostname)
  if (dotted !== null) return dotted[1]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(hostname)
  if (hex !== null) {
    const hi = parseInt(hex[1]!, 16)
    const lo = parseInt(hex[2]!, 16)
    return `${String(hi >> 8)}.${String(hi & 0xff)}.${String(lo >> 8)}.${String(lo & 0xff)}`
  }
  return undefined
}

function isIpAddress(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/u.test(hostname) || hostname.includes(':')
}

export function assertSafeUrl(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MCP server URL must use http: or https: protocol.')
  }
  const raw = parsed.hostname.toLowerCase()
  const stripped = raw.endsWith('.') ? raw.slice(0, -1) : raw
  const hostname = stripped.startsWith('[') && stripped.endsWith(']') ? stripped.slice(1, -1) : stripped
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return
  }
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      throw new Error(`MCP server hostname "${hostname}" is blocked.`)
    }
  }
  if (isIpAddress(hostname)) {
    const mapped = extractMappedIPv4(hostname)
    const ipv4Target = mapped ?? hostname
    for (const pattern of PRIVATE_IPV4_PATTERNS) {
      if (pattern.test(ipv4Target)) {
        throw new Error(`MCP server address "${hostname}" is a private IP and is blocked.`)
      }
    }
    if (mapped === undefined) {
      for (const pattern of PRIVATE_IPV6_PATTERNS) {
        if (pattern.test(hostname)) {
          throw new Error(`MCP server address "${hostname}" is a private IP and is blocked.`)
        }
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

export const noRedirectFetch: typeof globalThis.fetch = async (input, init) => {
  const res = await globalThis.fetch(input, { ...init, redirect: 'manual' })
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`MCP server returned HTTP ${String(res.status)} redirect; redirects are blocked for security.`)
  }
  return res
}

/**
 * `noRedirectFetch` whose response bodies fail once they pass `maxBytes`, so
 * an oversized reply errors while it streams in instead of being buffered.
 */
export function byteCappedFetch(maxBytes: number): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await noRedirectFetch(input, init)
    if (res.body === null) return res
    let received = 0
    const capped = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > maxBytes) {
          controller.error(new Error(`MCP server response is larger than ${String(maxBytes)} bytes.`))
          return
        }
        controller.enqueue(chunk)
      },
    }))
    return new Response(capped, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
}

async function connectClient(
  url: string,
  auth: McpAuth | undefined,
  signal: AbortSignal,
  maxResponseBytes?: number,
) {
  assertSafeUrl(url)
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    {
      requestInit: { headers: buildHeaders(auth), signal },
      fetch: maxResponseBytes === undefined ? noRedirectFetch : byteCappedFetch(maxResponseBytes),
    },
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
  const signal = AbortSignal.timeout(MCP_LIMITS.probeTimeoutMs)
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
    // A server without the tools capability (resources only, say) has an empty
    // catalog; the SDK refuses tools/list to it.
    const listsTools = client.getServerCapabilities?.()?.tools !== undefined
    for (let page = 0; listsTools && page < MCP_LIMITS.maxCatalogPages; page++) {
      const result = await client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal },
      )
      for (const tool of result.tools) {
        if (tools.length >= MCP_LIMITS.maxToolsPerServer) break
        const pName = publicToolName(serverName, tool.name)
        if (seenNames.has(pName)) {
          throw new Error(`Server listed tool "${tool.name}" more than once`)
        }
        seenNames.add(pName)
        const hint = (tool as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint
        const outSchema = supportedOutputSchema((tool as { outputSchema?: unknown }).outputSchema)
        tools.push({
          name: tool.name,
          publicName: pName,
          description: tool.description ?? '',
          inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
          ...(outSchema !== undefined ? { outputSchema: outSchema } : {}),
          ...(hint !== undefined ? { annotations: { readOnlyHint: hint } } : {}),
        })
      }
      if (tools.length >= MCP_LIMITS.maxToolsPerServer) break
      cursor = result.nextCursor ?? undefined
      if (cursor === undefined) break
      if (seenCursors.has(cursor)) {
        throw new Error(`Server repeated a tools/list continuation cursor`)
      }
      seenCursors.add(cursor)
    }

    const serverVersion = client.getServerVersion?.()
    const instructions = client.getInstructions?.()
    const resources = client.getServerCapabilities?.()?.resources !== undefined

    return {
      tools,
      serverInfo: serverVersion
        ? { name: serverVersion.name, version: serverVersion.version }
        : undefined,
      instructions: typeof instructions === 'string' && instructions.length > 0
        ? instructions.slice(0, MCP_LIMITS.maxInstructionsLength)
        : undefined,
      resources,
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
  const effectiveTimeout = timeoutMs ?? MCP_LIMITS.callTimeoutMs
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
      structuredContent: (result as { structuredContent?: unknown }).structuredContent,
      isError: result.isError === true,
    }
  } catch (error) {
    throw new Error(scrubMcpErrorMessage(error instanceof Error ? error.message : String(error)))
  } finally {
    await client.close()
  }
}

/**
 * Run one resources/* operation on a fresh connection. Each response body is
 * capped at {@link MCP_LIMITS.maxResourceResponseBytes}. A list without a
 * cursor follows the server's pages, as the SDK would, until
 * {@link MCP_LIMITS.maxCatalogPages} pages or a page that would bring the
 * listed entries past that many UTF-8 bytes, and returns the cursor where it
 * stops so the caller can continue.
 */
export async function requestResources(
  url: string,
  request: McpResourceRequest,
  auth?: McpAuth,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const effectiveTimeout = timeoutMs ?? MCP_LIMITS.callTimeoutMs
  const deadline = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(effectiveTimeout)])
    : AbortSignal.timeout(effectiveTimeout)
  let conn: Awaited<ReturnType<typeof connectClient>>
  try {
    conn = await connectClient(url, auth, deadline, MCP_LIMITS.maxResourceResponseBytes)
  } catch (error) {
    throw new Error(scrubMcpErrorMessage(error instanceof Error ? error.message : String(error)))
  }
  try {
    const { client } = conn
    if (request.method === 'resources/read') {
      return await client.readResource({ uri: request.uri }, { signal: deadline }) as Record<string, unknown>
    }
    const key = request.method === 'resources/list' ? 'resources' : 'resourceTemplates'
    const page = (cursor: string | undefined) => request.method === 'resources/list'
      ? client.listResources(cursor === undefined ? undefined : { cursor }, { signal: deadline })
      : client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, { signal: deadline })
    if (request.cursor !== undefined) return await page(request.cursor) as Record<string, unknown>
    const items: unknown[] = []
    const seenCursors = new Set<string>()
    let bytes = 0
    let cursor: string | undefined
    for (let pages = 0; pages < MCP_LIMITS.maxCatalogPages; pages++) {
      const result = await page(cursor) as Record<string, unknown>
      const listed = Array.isArray(result[key]) ? result[key] as unknown[] : []
      const size = new TextEncoder().encode(JSON.stringify(listed)).byteLength
      // A page that would pass the budget is left for the caller: `cursor` still names it.
      if (items.length > 0 && bytes + size > MCP_LIMITS.maxResourceResponseBytes) break
      items.push(...listed)
      bytes += size
      const next = typeof result['nextCursor'] === 'string' ? result['nextCursor'] : undefined
      if (next === undefined) {
        cursor = undefined
        break
      }
      if (seenCursors.has(next)) throw new Error(`Server repeated a ${request.method} continuation cursor`)
      seenCursors.add(next)
      cursor = next
    }
    return cursor === undefined ? { [key]: items } : { [key]: items, nextCursor: cursor }
  } catch (error) {
    throw new Error(scrubMcpErrorMessage(error instanceof Error ? error.message : String(error)))
  } finally {
    await conn.close()
  }
}
