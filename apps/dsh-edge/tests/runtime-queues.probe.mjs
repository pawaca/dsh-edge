/** Real prebuilt Worker + two browser tabs + controlled HTTP tool executors. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
const state = mkdtempSync(join(tmpdir(), 'dsh-runtime-probe-'))
const requests = []
const tools = []
const held = new Map()
const delays = []
let peak = 0
let mockOrigin
const mock = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  if (req.url === '/anthropic/v1/messages') {
    const path = `/pool/${tools.length + 1}`
    tools.push(path)
    held.set(path, res)
    peak = Math.max(peak, held.size)
    res.on('close', () => held.delete(path))
    return
  }
  const last = body.messages.findLast(m => m.role === 'user')
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content)
  requests.push(text)
  const afterUser = body.messages.slice(body.messages.lastIndexOf(last) + 1)
  const hasResults = afterUser.some(m => m.role === 'tool')
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = delta => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
  emit({ role: 'assistant' })
  if (text.includes('hold-A')) await new Promise(resolve => delays.push(resolve))
  if (text.includes('pool-probe') && !hasResults) {
    emit({ tool_calls: [1, 2, 3].map(n => ({ index: n - 1, id: `pool_${n}`, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ queries: [`pool-${n}`] }) } })) })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\n`)
  } else {
    emit({ content: 'probe-complete' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`)
  }
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
mockOrigin = `http://127.0.0.1:${mock.address().port}`
let worker, browser, startWorker
const release = path => {
  const res = held.get(path)
  assert.ok(res, `missing held ${path}`)
  held.delete(path)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ content: [{ type: 'text', text: `finished ${path}` }] }))
}
const wait = async (predicate, label, timeoutMs = 20000) => {
  const end = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}; tools=${tools.join(',')}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
try {
  const config = join(state, 'wrangler.json')
  await writePrebuiltModeWranglerConfig(mode, config)
  startWorker = () => unstable_dev(workerArtifactPath(mode), {
    config, env: mode === 'direct' ? '' : 'isolated', persistTo: state,
    vars: { DSH_EDGE_ACCESS_KEY: 'runtime-probe-owner-key-32-bytes', DEEPSEEK_API_KEY: 'local-mock-only', DEEPSEEK_BASE_URL: mockOrigin, DEEPSEEK_SEARCH_BASE_URL: `${mockOrigin}/anthropic/v1` },
    logLevel: 'error', experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false, watch: false },
  })
  worker = await startWorker()
  browser = await chromium.launch(process.env.DSH_EDGE_PLAYWRIGHT_CHANNEL ? { channel: process.env.DSH_EDGE_PLAYWRIGHT_CHANNEL } : {})
  const context = await browser.newContext()
  const origin = `http://${worker.address}:${worker.port}`
  const login = await context.request.post(`${origin}/api/auth/login`, { form: { accessKey: 'runtime-probe-owner-key-32-bytes' } })
  assert.ok(login.ok())
  const a = await context.newPage(), b = await context.newPage()
  await Promise.all([a.goto(origin), b.goto(origin)])
  const rpc = (page, method, payload, rpcId = crypto.randomUUID()) => page.evaluate(async ({ method, payload, rpcId }) => {
    const response = await fetch(`/api/${method.replace('.', '/')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, payload: { args: { request: payload } } }) })
    return response.json()
  }, { method, payload, rpcId })
  const prompt = (page, sessionId, text, id) => rpc(page, 'session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] }, id)
  for (const sessionId of ['probe-a', 'probe-b', 'probe-pool']) assert.equal((await rpc(a, 'session.create', { sessionId })).result.ok, true)
  // Observe actual mux pushes in the second tab, including durable queued inputs.
  await b.evaluate(() => {
    globalThis.probeFrames = []
    globalThis.probeMux = new WebSocket(`${location.origin.replace('http', 'ws')}/api/events.mux`)
    globalThis.probeMux.onmessage = event => globalThis.probeFrames.push(JSON.parse(event.data).payload)
  })
  await b.waitForFunction(() => globalThis.probeMux.readyState === WebSocket.OPEN)
  assert.equal((await prompt(a, 'probe-a', 'hold-A', 'a-first')).result.ok, true)
  await wait(() => requests.some(t => t.includes('hold-A')), 'A model start')
  assert.equal((await prompt(b, 'probe-b', 'B waits', 'b-first')).result.ok, true)
  assert.equal((await prompt(b, 'probe-b', 'B waits', 'b-first')).result.ok, true)
  await wait(() => b.evaluate(() => globalThis.probeFrames.some(f => f.type === 'session/queue' && f.sessionId === 'probe-b' && f.items.length === 1)), 'B queued once in second tab')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(requests.some(t => t === 'B waits'), false, 'B must not start while A owns slot')
  console.log('PASS two browser tabs: B durably queued once; no B LLM while A active')
  for (const resolve of delays.splice(0)) resolve()
  await wait(() => requests.some(t => t === 'B waits'), 'B starts after A releases')
  const history = await rpc(b, 'session.history', { sessionId: 'probe-b' })
  assert.equal(history.result.value.events.filter(e => e.event.type === 'user/message').length, 1)
  console.log('PASS duplicate receipt: one canonical B user message')
  await wait(() => b.evaluate(() => globalThis.probeFrames.some(f => f.type === 'session/queue' && f.sessionId === 'probe-b' && f.items.length === 0)), 'B dequeued')
  assert.equal((await prompt(a, 'probe-pool', 'pool-probe', 'pool-first')).result.ok, true)
  try { await wait(() => tools.length === 2, 'first two tool requests') }
  catch (error) {
    const debug = await rpc(a, 'session.history', { sessionId: 'probe-pool' })
    console.log('probe diagnostics', JSON.stringify(debug.result.value.events.filter(e => ['tool/result', 'turn/end', 'assistant/message'].includes(e.event.type))))
    console.log('model prompt observations', requests)
    throw error
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(tools.length, 2, 'third tool must wait for a permit')
  release('/pool/1')
  await wait(() => tools.length === 3, 'third tool after first completes')
  assert.equal(peak, 2)
  release('/pool/2'); release('/pool/3')
  await wait(async () => (await rpc(a, 'session.history', { sessionId: 'probe-pool' })).result.value.events.some(e => e.event.type === 'turn/end'), 'pool turn completion')
  console.log('PASS actual HTTP tool pool: peak=2; tool 3 starts only after tool 1 releases')
  // Cancel while two provider HTTP requests are held and the third awaits a permit.
  tools.length = 0
  await rpc(a, 'session.create', { sessionId: 'probe-cancel' })
  await prompt(a, 'probe-cancel', 'pool-probe', 'cancel-first')
  await wait(() => tools.length === 2, 'cancellation fixture starts')
  const staleCancelStatus = await a.evaluate(async () => {
    const response = await fetch('/api/session.cancel', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-edge-turn-seq': '-1' },
      body: JSON.stringify({ type: 'client-request', method: 'session.cancel', rpcId: crypto.randomUUID(), payload: { sessionId: 'probe-cancel' } }),
    })
    return response.status
  })
  assert.equal(staleCancelStatus, 409)
  assert.equal(held.size, 2, 'stale tab cancellation cannot stop the current tools')
  assert.equal((await rpc(a, 'session.cancel', { sessionId: 'probe-cancel' })).result.ok, true)
  await wait(() => held.size === 0, 'real provider HTTP abort cleanup')
  assert.equal(tools.length, 2, 'cancelled third tool must never reach provider')
  console.log('PASS cancellation: provider connections close; waiting tool never starts')

  await rpc(a, 'session.create', { sessionId: 'probe-crash-a' })
  await rpc(a, 'session.create', { sessionId: 'probe-crash-b' })
  await prompt(a, 'probe-crash-a', 'hold-A crash', 'crash-a')
  await wait(() => requests.some(t => t === 'hold-A crash'), 'crash fixture running')
  await prompt(b, 'probe-crash-b', 'B after restart', 'crash-b')
  assert.equal(requests.some(t => t === 'B after restart'), false)
  await context.close() // no tabs or reconnect requests can drive the new instance
  await worker.stop()
  assert.equal(requests.some(t => t === 'B after restart'), false, 'B must not run during teardown')
  worker = await startWorker()
  await wait(() => requests.some(t => t === 'B after restart'), 'alarm resumes queued B without tabs', 45000)
  assert.equal(requests.filter(t => t === 'hold-A crash').length, 1, 'interrupted A must not be replayed')
  console.log('PASS persisted alarm: restart with all tabs closed starts queued B; interrupted A is not replayed')
  console.log(`PASS runtime queues probe (${mode})`)
} finally {
  for (const resolve of delays.splice(0)) resolve()
  for (const res of held.values()) res.destroy()
  await browser?.close()
  await worker?.stop()
  mock.closeAllConnections()
  await new Promise(resolve => mock.close(resolve))
  rmSync(state, { recursive: true, force: true })
}
