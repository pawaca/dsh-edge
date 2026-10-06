/**
 * Upgrade real data in place: run a published dsh-edge release, create the
 * kinds of state owners have (long, tool, subagent, PTC, image, forked, and
 * archived sessions; one-shot and periodic reminders; files; settings; MCP;
 * skills), stop it, start this candidate on the same persisted state, and
 * verify every piece survived and still works.
 *
 *   DSH_EDGE_UPGRADE_FROM=0.18.0 node tests/upgrade-from-release.probe.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { chatMessages, latestUserPromptIndex, startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

const from = process.env.DSH_EDGE_UPGRADE_FROM ?? '0.18.0'
const mode = 'isolated'
const ACCESS_KEY = 'upgrade-probe-owner-key-32-bytes!'
const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4XmP4z8DwHwAFAAH/NQZ7kgAAAABJRU5ErkJggg=='
const work = mkdtempSync(join(tmpdir(), 'dsh-edge-upgrade-'))
const state = join(work, 'state')
const mock = await startMockDeepSeek()
let worker
let cookie

execFileSync('npm', ['pack', `dsh-edge@${from}`, '--silent'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] })
execFileSync('tar', ['xzf', `dsh-edge-${from}.tgz`], { cwd: work })
const previousRoot = join(work, 'package')

async function start(appDirectory, label) {
  const config = join(work, `wrangler-${label}.json`)
  await writePrebuiltModeWranglerConfig(mode, config, appDirectory === undefined
    ? {}
    : { appDirectory, sourceConfigPath: join(appDirectory, 'wrangler.jsonc') })
  worker = await unstable_dev(workerArtifactPath(mode, appDirectory === undefined ? {} : { appDirectory }), {
    config, env: 'isolated', persistTo: state,
    vars: {
      DEEPSEEK_API_KEY: 'upgrade-probe-key',
      DEEPSEEK_BASE_URL: mock.url,
      DEEPSEEK_SEARCH_BASE_URL: `${mock.url}/anthropic/v1`,
      DSH_EDGE_ACCESS_KEY: ACCESS_KEY,
    },
    logLevel: process.env.DSH_EDGE_PROBE_LOG ?? 'error',
    experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false, watch: false },
  })
  const login = await fetch(`http://${worker.address}:${worker.port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessKey: ACCESS_KEY }).toString(),
    redirect: 'manual',
  })
  assert.equal(login.status, 303)
  cookie = login.headers.get('set-cookie').split(';', 1)[0]
}

function request(path, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('cookie', cookie)
  return worker.fetch(`http://dsh-edge.test${path}`, { ...init, headers })
}

async function json(path, init) {
  const response = await request(path, init)
  const text = await response.text()
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

async function rpc(method, payload) {
  const body = await json(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  assert.equal(body.result.ok, true, `${method}: ${JSON.stringify(body.result).slice(0, 400)}`)
  return body.result.value
}

async function turn(sessionId, message) {
  const response = await request(`/api/sessions/${sessionId}/turn`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }),
  })
  assert.equal(response.status, 200, `turn ${message}`)
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  assert.equal(events.at(-1)?.type, 'turn/end', `turn ${message} did not end`)
  return events
}

async function history(sessionId) {
  const response = await request(`/api/sessions/${sessionId}/events`)
  assert.equal(response.status, 200, `history ${sessionId}`)
  return (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
}

const textOf = content => typeof content === 'string' ? content
  : content.filter(block => block.type === 'text').map(block => block.text).join('')
/** The conversation as both formats render it: user prompts and assistant replies, in order. */
async function transcript(sessionId) {
  return (await history(sessionId)).flatMap((event) => {
    if (event.type === 'user/message' && event.data.source.kind === 'user') return [`user: ${textOf(event.data.content)}`]
    if (event.type === 'assistant/message') return [`assistant: ${textOf(event.data.message.content)}`]
    return []
  })
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() > until) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

function sqliteStats() {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.sqlite')) files.push(path)
    }
  }
  walk(state)
  const counts = {}
  for (const file of files) {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dsh_%'").all()) {
        counts[name] = (counts[name] ?? 0) + db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n
      }
    } finally { db.close() }
  }
  return counts
}

// A listed session's generated title: a top-level field before Harness 0.2.0, a projection since.
const listedTitle = item => item.projections?.values?.title ?? item.title

const passed = []
const pass = (label) => { passed.push(label); console.log(`PASS ${label}`) }

try {
  // ---- Previous release: create state ----
  await start(previousRoot, 'previous')
  const previousHealth = await json('/api/health')
  assert.equal(previousHealth.version, from)

  const long = (await rpc('session.create', {})).sessionId
  await turn(long, 'remember alpha')
  for (let n = 1; n < 25; n++) await turn(long, `history check ${n}`)

  const tools = (await rpc('session.create', {})).sessionId
  await (await request('/api/workspace/file?path=/workspace/session.txt', { method: 'PUT', body: 'upgrade-tool-value' })).text()
  await turn(tools, 'run the tool')
  await turn(tools, 'read the file /workspace/session.txt')

  const parent = (await rpc('session.create', {})).sessionId
  await turn(parent, 'delegate to a subagent please')

  const ptc = (await rpc('session.create', {})).sessionId
  await rpc('agentPreset.select', { agentId: ptc, agentPreset: 'ptc' })
  await turn(ptc, 'run some code')

  const image = (await rpc('session.create', {})).sessionId
  // Listed catalogs carry no modalities: 0.18's image model is the vision preview, 0.19's is deepseek-flash.
  const models = (await rpc('llm.models', {})).groups.flatMap(group => group.models)
  const vision = models.find(model => model.inputModalities?.includes('image'))
    ?? models.find(model => model.id === 'deepseek-flash')
    ?? models.find(model => /vision/u.test(model.id))
  await rpc('session.selectModel', { sessionId: image, provider: vision?.provider ?? 'deepseek-official', model: vision?.id ?? 'deepseek-v4-flash-vision-exp' })
  await rpc('session.prompt', {
    sessionId: image, mode: 'queue',
    content: [{ type: 'text', text: 'describe this image' }, { type: 'image', mediaType: 'image/png', data: IMAGE, name: 'fixture.png' }],
  })
  await waitFor(async () => (await history(image)).some(event => event.type === 'turn/end'), 'image turn')
  const imageRef = (await history(image)).find(event => event.type === 'user/message').data.content
    .find(block => block.type === 'image').attachment

  const reminders = (await rpc('session.create', {})).sessionId
  await turn(reminders, 'schedule once 3600')
  await turn(reminders, 'schedule every 7200')
  const dueSoon = (await rpc('session.create', {})).sessionId
  const dueDelaySeconds = 90
  await turn(dueSoon, `schedule once ${dueDelaySeconds}`)
  const dueAt = Date.now() + dueDelaySeconds * 1000

  const fork = (await rpc('session.fork', { sessionId: long })).sessionId
  const archived = (await rpc('session.create', {})).sessionId
  await turn(archived, 'remember alpha')
  // A title generated after archiving is shown but never persisted (#253); archive once it is stored.
  await waitFor(async () => (await history(archived)).some(event => event.type === 'session/title'
    && event.data.source?.kind !== 'fallback'), 'archived session title persisted')
  await rpc('workspace.archiveSession', { sessionId: archived })

  await json('/api/approval-mode', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'never' }) })
  await json('/api/mcp-servers', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ servers: [{ serverName: 'fixture', url: 'https://mcp.example.com/mcp', auth: { type: 'none' }, toolPolicy: { mode: 'read_only' } }] }),
  })
  // A Models page edit: renaming one model stores the whole list under `llm-deepseek`.
  const llmSection = (await rpc('settings/describe', { args: {} })).namespaces.find(entry => entry.ns === 'llm-deepseek')
  const editedModels = llmSection.value.models.map(model => model.id === 'deepseek-v4-pro' ? { ...model, name: 'Pro From Previous' } : model)
  await rpc('settings/mutate', { args: { ns: 'llm-deepseek', ops: [{ op: 'set', path: ['models'], value: editedModels }], expectedRevision: llmSection.revision } })
  await json('/api/skills', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'upgrade-skill', description: 'Upgrade fixture skill', content: 'Step 1: verify.', whenToUse: 'When upgrading' }),
  })
  await (await request('/api/workspace/file?path=/workspace/upgrade.txt', { method: 'PUT', body: 'upgrade file body' })).text()

  const sessionIds = [long, tools, parent, ptc, image, reminders, dueSoon, fork, archived]
  const before = {
    list: (await rpc('session.list', {})).items.map(item => ({ sessionId: item.sessionId, title: listedTitle(item), agentPreset: item.agentPreset })),
    transcripts: Object.fromEntries(await Promise.all(sessionIds.map(async id => [id, await transcript(id)]))),
    archived: (await rpc('workspace.list', {})).archivedSessionIds,
  }
  assert.ok(before.list.some(item => typeof item.title === 'string' && item.title !== ''), `no titled session to compare: ${JSON.stringify(before.list)}`)
  const childIds = before.list.map(item => item.sessionId).filter(id => !sessionIds.includes(id))
  assert.equal(childIds.length, 1, `expected one subagent child, found ${JSON.stringify(childIds)}`)
  assert.ok(Date.now() < dueAt - 15_000, 'the due-soon reminder must still be pending when the previous release stops')
  await worker.stop()
  // Whether the previous release's schedule_create takes a title, as the mock decides when it creates them.
  const previousReminderTitles = mock.requests.some(request => (request.tools ?? []).some(tool =>
    (tool.function?.name ?? tool.name) === 'schedule_create'
    && Object.hasOwn((tool.function?.parameters ?? tool.input_schema)?.properties ?? {}, 'title')))
  const remindersBeforeUpgrade = mock.requests.filter(request => {
    const latest = request.messages?.[latestUserPromptIndex(request.messages ?? [])]?.content
    return typeof latest === 'string' && latest.startsWith('[SCHEDULE REMINDER')
  }).length
  const rowsBefore = sqliteStats()
  console.log(`previous ${from} state: ${JSON.stringify(rowsBefore)}`)

  // ---- Candidate: upgrade in place ----
  const bootStarted = Date.now()
  await start(undefined, 'candidate')
  const ready = await request('/api/ready')
  assert.equal(ready.status, 200, await ready.text())
  const bootMs = Date.now() - bootStarted
  const health = await json('/api/health')
  assert.notEqual(health.upstreamVersion, previousHealth.upstreamVersion)
  pass(`candidate on Harness ${health.upstreamVersion} boots on ${from} (Harness ${previousHealth.upstreamVersion}) state in ${bootMs} ms, including migration`)

  const listed = (await rpc('session.list', {})).items
  for (const item of before.list) {
    const after = listed.find(candidate => candidate.sessionId === item.sessionId)
    assert.ok(after, `session ${item.sessionId} disappeared`)
    assert.equal(listedTitle(after), item.title, `title of ${item.sessionId}`)
    assert.equal(after.agentPreset, item.agentPreset, `preset of ${item.sessionId}`)
  }
  pass(`${before.list.length} sessions keep ids, titles, and presets`)

  for (const id of sessionIds) assert.deepEqual(await transcript(id), before.transcripts[id], `transcript of ${id}`)
  pass('every conversation reads back the same prompts and replies')

  const parentEvents = await history(parent)
  assert.ok(parentEvents.some(event => event.type === 'tool/result' && event.data.message.role === 'tool'), 'parent tool results use the v4 tool role')
  assert.ok(parentEvents.some(event => event.type === 'subagent/catalog' && JSON.stringify(event.data).includes(childIds[0])), 'parent catalog names its child')
  pass('subagent parent migrates with its child in the catalog')

  const continuedTurn = await turn(long, 'history check after upgrade')
  assert.equal(textOf(continuedTurn.findLast(event => event.type === 'assistant/message').data.message.content), 'history-ok')
  const continued = mock.requests.at(-1)
  assert.ok(chatMessages(continued).some(message => message.role === 'assistant' && message.content === 'remembered-alpha'), 'replayed context keeps the first reply')
  assert.ok(continued.messages !== undefined && continued.system !== undefined, 'the continued turn speaks the Messages wire')
  pass('the long session continues with its migrated context')

  assert.equal(textOf((await turn(tools, 'run the tool')).findLast(event => event.type === 'assistant/message').data.message.content), 'tool-finished')
  pass('tool sessions keep running tools')

  const listedReminders = await turn(reminders, 'list reminders')
  const listedViews = JSON.parse(textOf(listedReminders.find(event => event.type === 'tool/result').data.message.content))
  // A 0.18 reminder has no title and imports with one from its prompt; a titled (0.19+) reminder keeps its own.
  assert.deepEqual(listedViews.map(view => view.title).sort(), previousReminderTitles
    ? ['Fixture periodic', 'Fixture reminder']
    : ['schedule-fixture-periodic', 'schedule-fixture-reminder'], JSON.stringify(listedViews))
  pass(previousReminderTitles
    ? 'active reminders keep their titles and list through the tools'
    : 'active reminders import with generated titles and list through the tools')

  const reminderPrompt = request => {
    const messages = request.system === undefined ? request.messages : chatMessages(request)
    const latest = messages[latestUserPromptIndex(messages)]?.content
    return typeof latest === 'string' && latest.startsWith('[SCHEDULE REMINDER')
  }
  await waitFor(() => mock.requests.filter(reminderPrompt).length > remindersBeforeUpgrade, 'imported reminder fires after upgrade', Math.max(0, dueAt - Date.now()) + 60_000)
  pass('an imported reminder fires on its original schedule')

  const attachment = await rpc('session.attachment', { sessionId: image, attachmentId: imageRef.attachmentId })
  assert.equal(attachment.data, IMAGE)
  pass('image attachments stay readable')

  assert.deepEqual((await rpc('workspace.list', {})).archivedSessionIds, before.archived)
  assert.equal(await (await request('/api/workspace/file?path=/workspace/upgrade.txt')).text(), 'upgrade file body')
  assert.equal((await json('/api/approval-mode')).mode, 'never')
  assert.ok((await json('/api/mcp-servers')).servers.some(server => server.serverName === 'fixture'))
  assert.deepEqual((await json('/api/skills')).skills, ['upgrade-skill'])
  pass('archive set, workspace files, approval mode, MCP servers, and skills persist')

  const catalog = (await rpc('llm.models', {})).groups.flatMap(group => group.models)
  assert.deepEqual(catalog.map(model => model.id), editedModels.map(model => model.id))
  assert.equal(catalog.find(model => model.id === 'deepseek-v4-pro')?.name, 'Pro From Previous')
  const deepseek = (await rpc('settings/describe', { args: {} })).namespaces.find(entry => entry.ns === 'llm-deepseek')
  assert.deepEqual(deepseek.user, { models: editedModels })
  pass('Models page edits keep applying to the DeepSeek provider')

  await worker.stop()
  worker = undefined
  const rowsAfter = sqliteStats()
  console.log(`candidate state: ${JSON.stringify(rowsAfter)}`)
  // Every reminder kept: two still active, the fired one-shot kept as ended. A 0.18 release held them
  // in dsh_schedule_active and the upgrade imports them; from 0.19 on they stay in dsh_schedule_tasks.
  assert.equal(rowsAfter.dsh_schedule_tasks, rowsBefore.dsh_schedule_active ?? rowsBefore.dsh_schedule_tasks)
  console.log(`PASS upgrade from ${from}: ${passed.length} checks`)
} finally {
  await worker?.stop()
  await mock.close()
  rmSync(work, { recursive: true, force: true })
}
