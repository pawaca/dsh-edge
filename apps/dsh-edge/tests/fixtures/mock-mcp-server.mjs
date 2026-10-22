/**
 * Minimal MCP server fixture for integration tests.
 * Implements the Streamable HTTP transport with two test tools.
 */
import { createServer } from 'node:http'

const SERVER_INFO = { name: 'mock-mcp-test', version: '1.0.0' }

// 1x1 transparent PNG, 67 bytes base64
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const TOOLS = [
  {
    name: 'echo',
    description: 'Returns its input as output.',
    inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'The message to echo.' } }, required: ['message'] },
  },
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  {
    name: 'get_status',
    description: 'Returns server status (read-only).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'compute',
    description: 'Compute with structured output.',
    inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
    outputSchema: { type: 'object', properties: { result: { type: 'number' } }, required: ['result'] },
  },
  {
    name: 'screenshot',
    description: 'Returns a test PNG image.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function handleToolCall(name, args) {
  if (name === 'echo') return { content: [{ type: 'text', text: args.message ?? '' }] }
  if (name === 'add') return { content: [{ type: 'text', text: String(Number(args.a ?? 0) + Number(args.b ?? 0)) }] }
  if (name === 'get_status') return { content: [{ type: 'text', text: 'OK' }] }
  if (name === 'compute') return { content: [{ type: 'text', text: '42' }], structuredContent: { result: 42 } }
  if (name === 'screenshot') return { content: [{ type: 'image', data: TINY_PNG, mimeType: 'image/png' }] }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
}

/** Resources, offered when the server is started with `{ resources: true }`. */
const RESOURCES = [
  { uri: 'file:///notes.txt', name: 'notes', mimeType: 'text/plain' },
  { uri: 'file:///logo.png', name: 'logo', mimeType: 'image/png' },
  { uri: 'file:///huge.bin', name: 'huge', mimeType: 'application/octet-stream' },
]
const RESOURCE_TEMPLATES = [{ uriTemplate: 'file:///logs/{day}.txt', name: 'daily log' }]

function handleResource(method, params) {
  // Two pages: the first ends with a cursor; a repeated cursor stays on the second.
  if (method === 'resources/list') {
    return params?.cursor === undefined
      ? { resources: RESOURCES.slice(0, 2), nextCursor: 'page-2' }
      : { resources: RESOURCES.slice(2) }
  }
  if (method === 'resources/templates/list') return { resourceTemplates: RESOURCE_TEMPLATES }
  if (method === 'resources/read') {
    if (params?.uri === 'file:///notes.txt') return { contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'resource notes' }] }
    if (params?.uri === 'file:///logo.png') return { contents: [{ uri: params.uri, mimeType: 'image/png', blob: TINY_PNG }] }
    // Larger than the Edge's 1 MiB response cap.
    if (params?.uri === 'file:///huge.bin') return { contents: [{ uri: params.uri, mimeType: 'application/octet-stream', blob: 'A'.repeat(2 * 1024 * 1024) }] }
  }
  return undefined
}

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

export async function startMockMcpServer(port = 0, options = {}) {
  let sessionId = 0
  const requests = []

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        let message
        try { message = JSON.parse(body) } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(jsonRpcError(null, -32700, 'Parse error'))
          return
        }

        const { id, method, params } = message
        requests.push(method)

        if (method === 'initialize') {
          sessionId++
          res.writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': `session-${sessionId}`,
          })
          res.end(jsonRpcResponse(id, {
            protocolVersion: '2025-03-26',
            capabilities: {
              ...options.tools === false ? {} : { tools: { listChanged: false } },
              ...options.resources ? { resources: {} } : {},
            },
            serverInfo: SERVER_INFO,
          }))
          return
        }

        if (method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(jsonRpcResponse(id, { tools: TOOLS }))
          return
        }

        if (method === 'tools/call') {
          const result = handleToolCall(params?.name, params?.arguments ?? {})
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(jsonRpcResponse(id, result))
          return
        }

        const resource = options.resources ? handleResource(method, params) : undefined
        if (resource !== undefined) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(jsonRpcResponse(id, resource))
          return
        }

        if (method === 'notifications/initialized' || method === 'ping') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(id !== undefined ? jsonRpcResponse(id, {}) : '')
          return
        }

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(jsonRpcError(id, -32601, `Method not found: ${method}`))
      })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  await new Promise(resolve => { server.listen(port, '127.0.0.1', resolve) })
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/mcp`

  return {
    url,
    port: address.port,
    tools: TOOLS,
    requests,
    close: () => new Promise(resolve => { server.close(resolve) }),
  }
}
