/**
 * Minimal MCP server fixture for integration tests.
 * Implements the Streamable HTTP transport with two test tools.
 */
import { createServer } from 'node:http'

const SERVER_INFO = { name: 'mock-mcp-test', version: '1.0.0' }

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
]

function handleToolCall(name, args) {
  if (name === 'echo') return { content: [{ type: 'text', text: args.message ?? '' }] }
  if (name === 'add') return { content: [{ type: 'text', text: String(Number(args.a ?? 0) + Number(args.b ?? 0)) }] }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
}

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

export async function startMockMcpServer(port = 0) {
  let sessionId = 0

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

        if (method === 'initialize') {
          sessionId++
          res.writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': `session-${sessionId}`,
          })
          res.end(jsonRpcResponse(id, {
            protocolVersion: '2025-03-26',
            capabilities: { tools: { listChanged: false } },
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
    close: () => new Promise(resolve => { server.close(resolve) }),
  }
}
