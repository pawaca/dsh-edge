/** Local workerd burst/idle costs over promoted artifacts.
 * Default: runtime spans. DSH_EDGE_WATCH_TASKS=1 uses local cursor counters
 * around a copied Direct artifact because long-lived Remote traces can omit
 * completed turn spans. DSH_EDGE_COST_CURSOR=1 selects that mode explicitly;
 * DSH_EDGE_COST_CURSOR=0 forces spans for diagnostics, with completeness guards.
 * Counter/explorer requests bypass the application Durable Object.
 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unstable_dev } from 'wrangler'
import { chromium } from 'playwright'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'
const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
const root = mkdtempSync(join(tmpdir(), 'dsh-resource-cost-'))
const ownerKey = 'resource-cost-local-fixture-owner-key'
const mock = await startMockDeepSeek()
const observations = []
const appDirectory = process.env.DSH_EDGE_PROBE_PACKAGE
const artifactOptions = appDirectory === undefined ? {} : { appDirectory, sourceConfigPath: join(appDirectory, 'wrangler.jsonc') }
const cursorCounters = process.env.DSH_EDGE_COST_CURSOR === '1'
  || (process.env.DSH_EDGE_WATCH_TASKS === '1' && process.env.DSH_EDGE_COST_CURSOR !== '0')
let worker, browser, observer
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  const config = join(root, 'wrangler.json')
  await writePrebuiltModeWranglerConfig(mode, config, artifactOptions)
  let entry = workerArtifactPath(mode, artifactOptions)
  if (cursorCounters) {
    assert.equal(mode, 'direct', 'cursor instrumentation currently covers the single-module Direct artifact')
    const artifactRoot = join(root, 'artifact')
    mkdirSync(artifactRoot)
    copyFileSync(entry, join(artifactRoot, 'original.js'))
    entry = join(artifactRoot, 'instrumented.js')
    copyFileSync(new URL('./fixtures/storage-cost-worker.mjs', import.meta.url), entry)
    const settings = JSON.parse(readFileSync(config, 'utf8'))
    settings.main = entry
    settings.base_dir = artifactRoot
    settings.find_additional_modules = true
    settings.rules = [{ type: 'ESModule', globs: ['**/*.js'] }]
    writeFileSync(config, JSON.stringify(settings))
  }
  worker = await unstable_dev(entry, { config, env: mode === 'direct' ? '' : 'isolated', persistTo: root,
    vars: { DSH_EDGE_ACCESS_KEY: ownerKey, DEEPSEEK_API_KEY: 'local-only', DEEPSEEK_BASE_URL: mock.url }, logLevel: 'error',
    experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false, watch: false } })
  const login = await worker.fetch('/api/auth/login', { method: 'POST', body: `accessKey=${ownerKey}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
  const rpc = async (service, method, request) => {
    const r = await worker.fetch(`/api/${service}/${method}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), payload: { args: { request } } }) })
    const body = await r.json();assert.equal(body.result?.ok, true, JSON.stringify(body));return body.result.value
  }
  const query = async sql => {
    const r = await worker.fetch('/cdn-cgi/local/explorer/api/local/observability/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql }) })
    const body = await r.json();assert.ok(body.result?.rows, JSON.stringify(body));return body.result.rows
  }
  let counterEpoch
  const totals = async () => {
    if (cursorCounters) {
      const result = await (await worker.fetch('/api/_local/storage-cost')).json()
      counterEpoch ??= result.epoch
      assert.equal(result.epoch, counterEpoch, 'isolate replacement invalidated in-memory cost counters')
      return result.counts
    }
    const rows = await query(`SELECT name,count(*),coalesce(sum(json_extract(attributes,'$."cloudflare.durable_object.response.rows_written"')),0),coalesce(sum(json_extract(attributes,'$."cloudflare.durable_object.response.rows_read"')),0) FROM spans GROUP BY name`)
    const result = { sqlCalls: 0, rowsWritten: 0, rowsRead: 0, alarmSet: 0, alarmDelete: 0, alarmGet: 0, kvPut: 0, kvDelete: 0, kvGet: 0, alarms: 0 }
    for(const [name,count,w,r] of rows) {
      if(name==='alarm')result.alarms+=count
      if(name==='durable_object_storage_exec'){result.sqlCalls+=count;result.rowsWritten+=w;result.rowsRead+=r}
      if(!name.startsWith('durable_object'))continue
      for(const [suffix,key] of [['setAlarm','alarmSet'],['deleteAlarm','alarmDelete'],['getAlarm','alarmGet'],['put','kvPut'],['delete','kvDelete'],['get','kvGet']]) if(name.endsWith(suffix))result[key]+=count
    }
    return result
  }
  const quiet = async (flush = true) => {
    // Flush completed application request spans before reading explorer totals.
    // Readiness wakes a cold DO; omit the barrier when measuring parked idleness.
    if (flush) for(let i=0;i<2;i++){const r=await worker.fetch('/api/ready',{headers:{cookie}});assert.equal(r.status,200);await r.arrayBuffer()}
    let previous=''; let stable=0; for(let n=0;n<30;n++){ await pause(1000); const next=JSON.stringify(await totals()); stable=next===previous?stable+1:0;previous=next;if(stable>=2)return } throw Error('storage did not settle') }
  const phase = async (name, action, flushAfter = true) => {
    await quiet();const before=await totals();const start=Date.now();await action();const elapsed=Date.now()-start;await quiet(flushAfter);const after=await totals()
    const row={name,ms:elapsed,...Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]]))};observations.push(row);console.log(JSON.stringify(row));return row
  }
  const sessionId=(await rpc('session','create',{})).sessionId
  const turn = async message => {
    const r=await worker.fetch(`/api/sessions/${sessionId}/turn`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({message})});assert.equal(r.status,200);const events=(await r.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));assert.equal(events.at(-1)?.data.reason.kind,'completed')
  }
  await turn('hello')
  const reads = async () => { for(let wave=0;wave<5;wave++) await Promise.all(Array.from({length:4},()=>rpc('schedule','list',{limit:1}))) }
  await phase('empty task list: 20 reads / 4 concurrent',reads)
  const tasks=[]
  await phase('create 128 future tasks',async()=>{for(let i=0;i<128;i++)tasks.push(await rpc('schedule','create',{title:`t${i}`,prompt:'check',target:{kind:'session',sessionId},timing:{kind:'after',after_seconds:3600+i}}))})
  await phase('128 future tasks: 20 first-page reads',reads)
  if (process.env.DSH_EDGE_WATCH_TASKS === '1') {
    observer = await chromium.launch()
    const context = await observer.newContext()
    const origin = `http://${worker.address}:${worker.port}`
    await context.request.post(`${origin}/api/auth/login`, { form: { accessKey: ownerKey } })
    const page = await context.newPage()
    await page.goto(origin)
    const onboarding = page.getByRole('button', { name: 'Continue', exact: true })
    if (await onboarding.waitFor({ timeout: 2000 }).then(() => true, () => false)) await onboarding.click()
    await page.getByText('Automation tasks', { exact: true }).first().click()
    await page.getByText('t0', { exact: true }).first().waitFor()
  }
  const deliveryCost = await phase('128 receipts: manual delivery', async () => {
    for (const task of tasks) await rpc('schedule', 'run', { id: task.id })
    for (let i=0;i<600 && mock.requests.length<129;i++) await pause(100)
    assert.ok(mock.requests.length >= 129, 'all manual runs must execute')
  })
  assert.ok(deliveryCost.kvPut >= 128, 'telemetry must include every completed turn checkpoint')
  assert.ok(deliveryCost.rowsWritten >= 128 * 40, 'incomplete storage telemetry is not a cost pass')
  const delivered = await rpc('schedule', 'list', { limit: 128 })
  assert.equal(delivered.items.length, 128)
  assert.ok(delivered.items.every(task => task.lastDelivery !== undefined && !task.executionActive), 'all receipts must settle')
  if (appDirectory === undefined) {
    assert.ok(deliveryCost.alarms <= 8, 'fast turns must drain in bounded batches, not one alarm per input')
    assert.ok(deliveryCost.alarmSet <= 16, 'a burst must not rewrite the recovery alarm per turn')
    assert.ok(deliveryCost.rowsRead < (observer ? 100000 : 60000), 'future task lookup must use the due index')
  }
  await rpc('schedule','list',{limit:1}) // separate any cold activation from the warm burst
  const readCost = await phase('128 delivered tasks: 20 first-page reads',reads)
  if(appDirectory === undefined) { assert.ok(readCost.sqlCalls <= 45, 'pagination must not query every retained task'); assert.equal(readCost.rowsWritten,0); assert.equal(readCost.alarmSet,0) }
  browser=await chromium.launch()
  const context=await browser.newContext();const origin=`http://${worker.address}:${worker.port}`
  await context.request.post(`${origin}/api/auth/login`,{form:{accessKey:ownerKey}})
  let requests=0,sent=0,received=0,closed=0
  const urls={};const frames={}
  const page=await context.newPage()
  page.on('request',r=>{requests++;const path=new URL(r.url()).pathname;if(path.startsWith('/api/')) urls[path]=(urls[path]??0)+1})
  page.on('websocket',socket=>{socket.on('framesent',f=>{sent++;const frame=JSON.parse(String(f.payload));const key=frame.endpoint??frame.type;frames[key]=(frames[key]??0)+1});socket.on('framereceived',()=>received++);socket.on('close',()=>closed++)})
  await page.goto(origin);await page.getByRole('textbox').last().waitFor();await pause(1500)
  const before={requests,sent,received,closed};const idleMs=Number(process.env.DSH_EDGE_IDLE_MS??15000)
  await phase(`browser parked ${idleMs} ms, 128 tasks`,()=>pause(idleMs),false)
  const browserDelta={requests:requests-before.requests,sent:sent-before.sent,received:received-before.received,closed:closed-before.closed}
  console.log(JSON.stringify({browserDelta,urls,frames}))
  console.log(JSON.stringify({spanNames:await query('SELECT name,count(*) FROM spans GROUP BY name'),mode}))
  if(process.env.DSH_EDGE_PROBE_REPORT)writeFileSync(process.env.DSH_EDGE_PROBE_REPORT,JSON.stringify({mode,counters:cursorCounters?'workerd-cursor':'workerd-spans',observations,browserDelta,urls,frames},null,2)+'\n')
} finally {mock.releaseSlowResponses();await observer?.close();await browser?.close();await worker?.stop();await mock.close();rmSync(root,{recursive:true,force:true})}
