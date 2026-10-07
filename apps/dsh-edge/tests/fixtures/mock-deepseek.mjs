import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

/**
 * Deterministic DeepSeek stand-in for edge integration tests. It serves the
 * Messages wire the current release speaks and, for upgrade tests that run
 * an earlier published release, the chat-completions wire it spoke.
 * `requests` records the exact bodies; scenarios read them through
 * {@link chatMessages}, a role-per-message view in which tool results are
 * `tool` messages and loop notes are their own user prompts.
 */
/** Loop-owned user-role notes that are not a prompt: model changes, runtime-context snapshots, and system reminders. */
export function isLoopNote(message) {
  // Tools added to a running session (an upgrade adding glob and grep) arrive as tool_addition blocks.
  if (message.role === 'user' && Array.isArray(message.content) && message.content.length > 0
    && message.content.every(block => block.type === 'tool_addition')) return true
  return message.role === 'user' && typeof message.content === 'string'
    && (message.content.startsWith('[model changed: ') || message.content.startsWith('Current runtime context')
      || message.content.startsWith('<system-reminder>')
      // dsh-repeat-tool-reminder notices follow a repeated tool result.
      || message.content.startsWith('You are repeating the exact same tool call')
      || message.content.startsWith('Repeated tool call detected:')
      // A system prompt that changed mid-session (an upgrade adding tool sections) is a
      // `system-prompt` message, which the Messages wire carries in the user role.
      || message.content.startsWith('You are dsh-edge'))
}

/** The index of the latest user prompt in a chat request, skipping loop-owned notes. */
export function latestUserPromptIndex(messages) {
  return messages.findLastIndex(message => message.role === 'user' && !isLoopNote(message))
}

export async function startMockDeepSeek(port = 0) {
  const requests = []
  const searchRequests = []
  const slowResponseReleases = []
  let rateLimitedOnce = 0
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
    if (request.method !== 'POST' || (request.url !== '/v1/messages' && request.url !== '/chat/completions')) {
      response.writeHead(404).end()
      return
    }
    const legacyWire = request.url === '/chat/completions'

    let source = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { source += chunk })
    request.on('end', () => {
      const body = JSON.parse(source)
      requests.push(body)
      const messages = legacyWire ? body.messages : chatMessages(body)
      response.legacyWire = legacyWire
      const acceptsTitle = (body.tools ?? []).some(tool => (tool.function?.name ?? tool.name) === 'schedule_create'
        && Object.hasOwn((tool.function?.parameters ?? tool.input_schema)?.properties ?? {}, 'title'))
      const latestUserIndex = latestUserPromptIndex(messages)
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

      // One 429 with Retry-After, then a normal answer: exercises dsh-llm-retry.
      if (prompt === 'rate limited once' && rateLimitedOnce++ === 0) {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'mock rate limit' } }))
        return
      }

      // Upstream compaction appends its instruction as the final user message; answer with a short checkpoint.
      const finalMessage = messages.at(-1)
      if (finalMessage?.role === 'user' && messageText(finalMessage).startsWith('You are now acting as a compaction engine')) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: '## Goal\n- compact fixture' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
        ])
        return
      }

      // Deliverables: write a report, then declare it with upstream's present tool.
      if (prompt === 'present the report' && toolResults.length < 2) {
        const call = toolResults.length === 0
          ? { id: 'call_present_write', name: 'write', arguments: JSON.stringify({ file_path: '/workspace/report.md', content: '# Report\n' }) }
          : { id: 'call_present', name: 'present', arguments: JSON.stringify({ files: [{ path: '/workspace/report.md', description: 'The report' }] }) }
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
        ])
        return
      }

      if (prompt.startsWith('[SCHEDULE REMINDER')) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: 'schedule-delivered' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
        ])
        return
      }

      if (prompt.startsWith('schedule delete ') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_delete_schedule', type: 'function', function: {
            // `latest` names the most recent reminder id a tool result returned in this conversation.
            name: 'schedule_delete', arguments: JSON.stringify({ id: prompt === 'schedule delete latest'
              ? [...JSON.stringify(messages).matchAll(/schedule-[0-9a-f-]{36}/gu)].at(-1)?.[0]
              : prompt.slice('schedule delete '.length) }),
          } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
        ])
        return
      }

      if (prompt.startsWith('schedule once ') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_schedule', type: 'function', function: {
            name: 'schedule_create', arguments: JSON.stringify({ prompt: 'schedule-fixture-reminder', ...acceptsTitle ? { title: 'Fixture reminder' } : {}, after_seconds: Number(prompt.slice('schedule once '.length)) }),
          } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
        ])
        return
      }

      if (prompt.startsWith('schedule every ') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_schedule_every', type: 'function', function: {
            name: 'schedule_create', arguments: JSON.stringify({ prompt: 'schedule-fixture-periodic', ...acceptsTitle ? { title: 'Fixture periodic' } : {}, every_seconds: Number(prompt.slice('schedule every '.length)) }),
          } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
        ])
        return
      }

      if (prompt === 'list reminders' && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_schedule_list', type: 'function', function: { name: 'schedule_list', arguments: '{}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
        ])
        return
      }

      if (prompt.startsWith('delegate to a subagent') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_subagent', type: 'function', function: {
            name: 'subagent', arguments: JSON.stringify({ description: 'Fixture child', prompt: 'child fixture task', run_in_background: false }),
          } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
        ])
        return
      }

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

      if (prompt.includes('batch durable chunks')) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          ...Array.from({ length: 100 }, (_, index) => ({
            choices: [{ delta: { content: `chunk-${index}` } }],
          })),
          {
            choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 100 },
          },
        ])
        return
      }

      // dsh-fs-observation-policy: an unread edit is refused, then read and edit succeed;
      // an edit after bash changed the read file is refused as stale.
      const policySteps = {
        'policy edit unread': [
          ['edit', { file_path: '/workspace/policy.txt', old_string: 'alpha', new_string: 'beta' }],
          ['read', { file_path: '/workspace/policy.txt' }],
          ['edit', { file_path: '/workspace/policy.txt', old_string: 'alpha', new_string: 'beta' }],
        ],
        'policy stale edit': [
          ['read', { file_path: '/workspace/stale.txt' }],
          ['bash', { command: "printf 'changed\\n' >> /workspace/stale.txt", description: 'Change the file behind the read' }],
          ['edit', { file_path: '/workspace/stale.txt', old_string: 'one', new_string: 'two' }],
        ],
      }[prompt]
      if (policySteps !== undefined && toolResults.length < policySteps.length) {
        const [name, args] = policySteps[toolResults.length]
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `call_mock_policy_${String(toolResults.length + 1)}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
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

      // Three identical bash calls in a row, so the repeat-tool reminder fires once.
      if (prompt === 'find the needles' && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_mock_grep',
                    type: 'function',
                    function: { name: 'grep', arguments: JSON.stringify({ pattern: 'needle-\\d+', path: 'haystack', include: '*.txt' }) },
                  },
                  {
                    index: 1,
                    id: 'call_mock_glob',
                    type: 'function',
                    function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.txt', path: 'haystack' }) },
                  },
                ],
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

      if (prompt === 'write my checklist' && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_mock_todo',
                  type: 'function',
                  function: {
                    name: 'todo_write',
                    arguments: JSON.stringify({ todos: [
                      { content: 'Draft the checklist', status: 'completed' },
                      { content: 'Review the checklist', status: 'in_progress' },
                    ] }),
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

      if (prompt === 'repeat the same command' && toolResults.length < 3) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `call_mock_repeat_${String(toolResults.length + 1)}`,
                  type: 'function',
                  function: { name: 'bash', arguments: '{"command":"echo same","description":"Repeat one command"}' },
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

      if (prompt.includes('read the file') && !hasToolResult) {
        const fileMatch = /read the file (\S+)/u.exec(prompt)
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_mock_read',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({ file_path: fileMatch?.[1] ?? '/workspace/session.txt' }),
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

      if (prompt.includes('ask the user') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_mock_ask',
                  type: 'function',
                  function: {
                    name: 'ask_user_question',
                    arguments: JSON.stringify({ questions: [{
                      id: 'deploy',
                      question: 'Deploy now?',
                      header: 'Confirm',
                      options: [
                        { label: 'Yes (Recommended)', description: 'Ships the build.' },
                        { label: 'No', description: 'Keeps the current release.' },
                      ],
                    }] }),
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

      if (prompt.includes('plan the') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_mock_plan',
                  type: 'function',
                  function: {
                    name: 'exit_plan_mode',
                    arguments: JSON.stringify({ plan: '# Deploy plan\n\n1. Build.\n2. Ship.' }),
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

      if (prompt.includes('run some code') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_mock_run_code',
                  type: 'function',
                  function: {
                    name: 'run_code',
                    arguments: JSON.stringify({
                      description: 'Print a marker through bash',
                      code: [
                        'const out = await tools.bash({ command: "echo ptc-ok > ptc-marker.txt && cat ptc-marker.txt", description: "Write a marker" })',
                        'console.log("ran bash")',
                        // A file tool needs the turn's filesystem binding, so this call proves
                        // nested dispatches run inside the run_code call's async context.
                        'const read = await tools.read({ file_path: "ptc-marker.txt" })',
                        'return { out, read }',
                      ].join('\n'),
                    }),
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

      if (prompt.includes('run a workflow') && !hasToolResult) {
        sendEvents(response, [
          { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_mock_workflow',
                  type: 'function',
                  function: {
                    name: 'workflow',
                    arguments: JSON.stringify({
                      meta: { name: 'fan-out-check', description: 'Fan out five children.' },
                      args: { items: ['a', 'b', 'c', 'd', 'e'] },
                      script: [
                        "phase('Fan out')",
                        "const out = await pipeline(args.items, item => agent('workflow child ' + item, { label: item }), text => text + '!')",
                        'let total = 0',
                        'for (const text of out) total += text.length',
                        'return { out, total }',
                      ].join('\n'),
                    }),
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
            : prompt.includes('read the file')
              ? 'read-finished'
              : prompt.includes('ask the user')
              ? `question-finished:${messageText(toolResults[0])}`
              : prompt.includes('plan the')
                ? `plan-finished:${messageText(toolResults[0])}`
                : prompt.includes('run a workflow')
                  ? `workflow-finished:${messageText(toolResults[0])}`
                  : prompt.includes('run some code')
                    ? `code-finished:${messageText(toolResults[0])}`
                    : prompt === 'find the needles'
                      ? 'search-finished'
                    : prompt === 'write my checklist'
                      ? `todo-finished:${messageText(toolResults[0])}`
                    : prompt === 'repeat the same command'
                      ? 'repeat-finished'
                      : prompt.startsWith('policy ')
                        ? 'policy-finished'
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
      } else if (prompt === 'rate limited once') {
        text = 'retry-finished'
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

/** One Messages request as role-per-message chat entries. */
export function chatMessages(body) {
  const messages = []
  if (body.system !== undefined) {
    messages.push({ role: 'system', content: typeof body.system === 'string' ? body.system : blockText(body.system) })
  }
  for (const message of body.messages ?? []) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    if (message.role === 'assistant') {
      const calls = blocks.filter(block => block.type === 'tool_use')
      messages.push({
        role: 'assistant',
        content: blockText(blocks),
        ...calls.length === 0 ? {} : { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) },
      })
      continue
    }
    for (const block of blocks.filter(block => block.type === 'tool_result')) {
      messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: typeof block.content === 'string' ? block.content : blockText(block.content ?? []) })
    }
    // A Messages user turn merges consecutive user messages (loop notes, an
    // unanswered prompt, the next prompt); each text block is its own entry,
    // and an image stays with the text before it.
    let parts = []
    const flush = () => {
      if (parts.length === 0) return
      messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
      parts = []
    }
    for (const block of blocks.filter(block => block.type !== 'tool_result')) {
      if (block.type === 'text') flush()
      parts.push(block)
    }
    flush()
  }
  return messages
}

function blockText(blocks) {
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

/** Write Messages stream events as server-sent events. */
export function writeEvents(response, events) {
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

const STOP_REASONS = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens' }

/** Translate one scenario's chat-style chunks into Messages stream events, grouped per chunk. */
export function messagesEvents(chunks) {
  const usage = chunks.findLast(chunk => chunk.usage !== undefined)?.usage ?? {}
  let index = -1
  let open
  const close = events => {
    if (open === undefined) return
    events.push({ type: 'content_block_stop', index })
    open = undefined
  }
  const start = (events, block) => {
    close(events)
    index += 1
    open = block.type
    events.push({ type: 'content_block_start', index, content_block: block })
  }
  const groups = chunks.map((chunk, position) => {
    const events = position === 0
      ? [{ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: 0 } } }]
      : []
    const choice = chunk.choices?.[0] ?? {}
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (open !== 'text') start(events, { type: 'text', text: '' })
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta.content } })
    }
    for (const call of delta.tool_calls ?? []) {
      start(events, { type: 'tool_use', id: call.id, name: call.function.name, input: {} })
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.function.arguments } })
    }
    if (choice.finish_reason !== undefined) {
      close(events)
      events.push({ type: 'message_delta', delta: { stop_reason: STOP_REASONS[choice.finish_reason] ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.completion_tokens ?? 0 } })
      events.push({ type: 'message_stop' })
    }
    return events
  })
  return groups
}

function sendEvents(response, chunks, delayMs = 0, continueAfterFirstEvent) {
  const groups = response.legacyWire
    ? chunks.map(chunk => [chunk]).concat([['[DONE]']])
    : messagesEvents(chunks)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const write = (index) => {
    if (response.writableEnded || response.destroyed) return
    const group = groups[index]
    if (group === undefined) {
      response.end()
      return
    }
    if (response.legacyWire) {
      for (const chunk of group) response.write(`data: ${chunk === '[DONE]' ? chunk : JSON.stringify(chunk)}\n\n`)
    } else {
      writeEvents(response, group)
    }
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
