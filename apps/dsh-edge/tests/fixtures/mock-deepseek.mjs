import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

/** Start a deterministic chat-completions SSE stand-in for edge integration tests. */
export async function startMockDeepSeek(port = 0) {
  const requests = []
  const searchRequests = []
  const slowResponseReleases = []
  let origin
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/requests') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(requests))
      return
    }
    if (request.method === 'GET' && request.url === '/fetch-page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
<html>
  <head>
    <title>Worker fetch fixture</title>
    <style>.hidden { display: none; }</style>
  </head>
  <body>
    <main>
      <h1>Worker Fetch</h1>
      <p>Rendered <strong>inside</strong> Cloudflare.</p>
      <table><thead><tr><th>Mode</th><th>Result</th></tr></thead><tbody><tr><td>HTTP</td><td>Markdown</td></tr></tbody></table>
      <script>globalThis.fixtureMustNotAppear = true</script>
    </main>
  </body>
</html>`)
      return
    }
    if (request.method === 'POST' && request.url === '/anthropic/v1/messages') {
      let source = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { source += chunk })
      request.on('end', () => {
        searchRequests.push({
          body: JSON.parse(source),
          apiKey: request.headers['x-api-key'],
          authorization: request.headers.authorization,
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          content: [
            {
              type: 'text',
              text: 'Mock search answer.',
              citations: [{
                type: 'web_search_result_location',
                url: 'https://example.com/current',
                cited_text: 'Current information from the mock source.',
              }],
            },
            {
              type: 'web_search_tool_result',
              content: [{
                type: 'web_search_result',
                url: 'https://example.com/current',
                title: 'Current mock result',
                page_age: '2026-08-18',
              }],
            },
          ],
        }))
      })
      return
    }
    if (request.method === 'POST' && request.url === '/files') {
      const chunks = []
      request.on('data', chunk => { chunks.push(chunk) })
      request.on('end', () => {
        const now = Math.floor(Date.now() / 1000)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: `file-mock-${now}`,
          object: 'file',
          bytes: Buffer.concat(chunks).length,
          created_at: now,
          expires_at: now + 86400,
          filename: 'mock-upload.png',
          purpose: 'attachments',
        }))
      })
      return
    }
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404).end()
      return
    }

    let source = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { source += chunk })
    request.on('end', () => {
      const body = JSON.parse(source)
      requests.push(body)
      const messages = Array.isArray(body.messages) ? body.messages : []
      const latestUserIndex = messages.findLastIndex(message => message.role === 'user')
      const latestUser = messages[latestUserIndex]
      const rawContent = latestUser?.content
      const prompt = typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent.filter(p => p.type === 'text').map(p => p.text).join(' ')
          : ''
      const toolResults = messages.slice(latestUserIndex + 1)
        .filter(message => message.role === 'tool')
      const hasToolResult = toolResults.length > 0

      if (prompt.includes('slow')) {
        const continueAfterFirstEvent = new Promise(resolve => {
          slowResponseReleases.push(resolve)
        })
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          { choices: [{ delta: { content: 'too-late' } }] },
          {
            choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 1 },
          },
        ], 0, continueAfterFirstEvent)
        return
      }

      if (prompt.includes('tool') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_mock_file',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: '{"command":"cat /workspace/session.txt","description":"Read the session file"}',
                  },
                }],
              },
            }],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 8, completion_tokens: 3 },
          },
        ])
        return
      }

      if (prompt.includes('web search') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_mock_search',
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: '{"queries":["current mock information"]}',
                  },
                }],
              },
            }],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 8, completion_tokens: 3 },
          },
        ])
        return
      }

      if (prompt.includes('web fetch') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_mock_fetch',
                  type: 'function',
                  function: {
                    name: 'web_fetch',
                    arguments: JSON.stringify({ url: `${origin}/fetch-page` }),
                  },
                }],
              },
            }],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 8, completion_tokens: 3 },
          },
        ])
        return
      }

      let text = 'remembered-alpha'
      if (hasToolResult) {
        text = prompt.includes('web search')
          ? 'search-finished'
          : prompt.includes('web fetch')
            ? 'fetch-finished'
            : 'tool-finished'
      }
      if (prompt.includes('continue released fixture')) {
        const hasReleasedPrompt = messages.some(message =>
          message.role === 'user' && messageText(message) === 'fixture prompt')
        const hasReleasedAnswer = messages.some(message =>
          message.role === 'assistant' && messageText(message) === 'fixture response')
        text = hasReleasedPrompt && hasReleasedAnswer
          ? 'released-history-ok'
          : 'released-history-missing'
      } else if (prompt.includes('released history')) {
        const hasReleasedContinuation = messages.some(message =>
          message.role === 'assistant' && messageText(message) === 'released-history-ok')
        text = hasReleasedContinuation ? 'released-history-ok' : 'released-history-missing'
      } else if (prompt.includes('history')) {
        const hasPriorAnswer = messages.some(message =>
          message.role === 'assistant' && message.content === 'remembered-alpha')
        text = hasPriorAnswer ? 'history-ok' : 'history-missing'
      }
      sendEvents(response, [
        { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
        { choices: [{ delta: { content: text } }] },
        {
          choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 2 },
        },
      ])
    })
  })

  await new Promise(resolve => { server.listen(port, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server has no port.')
  origin = `http://127.0.0.1:${address.port}`
  return {
    url: origin,
    requests,
    searchRequests,
    releaseSlowResponses() {
      for (const release of slowResponseReleases.splice(0)) release()
    },
    close: () => new Promise(resolve => { server.close(resolve) }),
  }
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
}

function sendEvents(response, events, delayMs = 0, continueAfterFirstEvent) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const write = (index) => {
    if (response.writableEnded || response.destroyed) return
    const event = events[index]
    if (event === undefined) {
      response.end('data: [DONE]\n\n')
      return
    }
    response.write(`data: ${JSON.stringify(event)}\n\n`)
    const writeNext = () => { setTimeout(() => { write(index + 1) }, delayMs) }
    if (index === 0 && continueAfterFirstEvent !== undefined) {
      void continueAfterFirstEvent.then(writeNext)
      return
    }
    writeNext()
  }
  write(0)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.DSH_EDGE_MOCK_PORT ?? '9797')
  const mock = await startMockDeepSeek(port)
  process.stdout.write(`mock-deepseek ready on ${mock.url}\n`)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void mock.close().then(() => { process.exit(0) })
    })
  }
}
