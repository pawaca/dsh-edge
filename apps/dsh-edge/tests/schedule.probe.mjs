/** Real two-tab admission, busy-session reminders, deletion and restart recovery. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'
const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
const state = mkdtempSync(join(tmpdir(), 'dsh-schedule-probe-'))
const mock = await startMockDeepSeek()
const ownerKey = 'schedule-probe-owner-key-32-bytes'
let worker, browser
const latest = request => request.messages.findLast(message => message.role === 'user')?.content
const reminders = () => mock.requests.filter(request => typeof latest(request) === 'string' && latest(request).startsWith('[SCHEDULE REMINDER'))
const wait = async (predicate, label, timeout = 30_000) => {
  const until = Date.now() + timeout
  while (!await predicate()) {
    if (Date.now() > until) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
try {
  const config = join(state, 'wrangler.json')
  await writePrebuiltModeWranglerConfig(mode, config)
  const start = () => unstable_dev(workerArtifactPath(mode), {
    config, env: mode === 'direct' ? '' : 'isolated', persistTo: state,
    vars: { DSH_EDGE_ACCESS_KEY: ownerKey, DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: mock.url },
    logLevel: 'error', experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false, watch: false },
  })
  worker = await start()
  browser = await chromium.launch(process.env.DSH_EDGE_PLAYWRIGHT_CHANNEL ? { channel: process.env.DSH_EDGE_PLAYWRIGHT_CHANNEL } : {})
  const context = await browser.newContext()
  const origin = `http://${worker.address}:${worker.port}`
  assert.ok((await context.request.post(`${origin}/api/auth/login`, { form: { accessKey: ownerKey } })).ok())
  const a = await context.newPage(), b = await context.newPage()
  await Promise.all([a.goto(origin), b.goto(origin)])
  const rpc = (page, method, payload) => page.evaluate(async ({ method, payload }) => {
    const response = await fetch(`/api/${method.replace('.', '/')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), payload: { args: { request: payload } } }) })
    return (await response.json()).result
  }, { method, payload })
  const prompt = async (page, sessionId, text) => {
    const result = await rpc(page, 'session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
    assert.ok(result.ok, JSON.stringify(result))
  }
  const history = async id => (await rpc(a, 'session.history', { sessionId: id })).value.events.map(entry => entry.event)
  const ended = async (id, count) => (await history(id)).filter(event => event.type === 'turn/end').length >= count
  for (const id of ['schedule-a', 'busy-b', 'deleted', 'restart']) assert.ok((await rpc(a, 'session.create', { sessionId: id })).ok)
  await prompt(a, 'schedule-a', 'schedule once 5')
  await wait(() => ended('schedule-a', 1), 'schedule created')
  await prompt(b, 'busy-b', 'slow busy fixture')
  await wait(() => mock.requests.some(request => latest(request) === 'slow busy fixture'), 'busy turn entered model')
  await prompt(a, 'schedule-a', 'queued user input')
  await new Promise(resolve => setTimeout(resolve, 6000))
  assert.equal(reminders().length, 0, 'a due reminder must not start alongside the busy session')
  assert.equal(mock.requests.some(request => latest(request) === 'queued user input'), false)
  mock.releaseSlowResponses()
  await wait(() => reminders().length === 1, 'reminder after slot release')
  assert.ok(mock.requests.findIndex(request => latest(request) === 'queued user input') < mock.requests.findIndex(request => typeof latest(request) === 'string' && latest(request).startsWith('[SCHEDULE REMINDER')))
  await wait(() => ended('schedule-a', 3), 'user and reminder turns complete')
  const events = await history('schedule-a')
  assert.equal(events.filter(event => event.type === 'schedule/change' && event.data.operation === 'dispatch').length, 1)
  console.log(`PASS ${mode}: two tabs, busy B blocks A reminder; queued user input executes first; one dispatch`)

  await prompt(a, 'deleted', 'schedule once 3')
  await wait(() => ended('deleted', 1), 'deletable reminder created')
  await prompt(a, 'deleted', 'schedule delete schedule-1')
  await wait(() => ended('deleted', 2), 'delete completed')
  assert.ok((await history('deleted')).some(event => event.type === 'schedule/change' && event.data.operation === 'delete'))
  await new Promise(resolve => setTimeout(resolve, 3500))
  assert.equal(reminders().length, 1)
  console.log(`PASS ${mode}: deleted reminder does not fire`)

  await prompt(a, 'restart', 'schedule once 10')
  await wait(() => ended('restart', 1), 'restart reminder committed')
  await context.close()
  await worker.stop()
  worker = await start()
  // No browser or API wake after restart: only watch the external provider.
  await wait(() => reminders().length === 2, 'alarm after process restart')
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(reminders().length, 2)
  console.log(`PASS ${mode}: persisted alarm wakes original session after Worker restart; no duplicate delivery`)
} finally {
  mock.releaseSlowResponses()
  await browser?.close()
  await worker?.stop()
  await mock.close()
  rmSync(state, { recursive: true, force: true })
}
