/**
 * Compare Durable Object storage cost between a published release and this
 * candidate, on the same scripted conversation, as the Workers runtime counts
 * it, not as Node SQLite reports it.
 *
 *   DSH_EDGE_COST_FROM=0.26.1 node tests/row-cost.probe.mjs
 *
 * Two quantities, because Cloudflare bills rows written and read by SQL
 * statements and by the SQLite-backed key-value and alarm operations alike:
 * - SQL rows: `rows_written` / `rows_read` on every SQL span workerd records.
 * - KV and alarm writes: workerd attaches no row count to those spans, so the
 *   probe counts the operations (`put`, `delete`, `setAlarm`, `deleteAlarm`),
 *   matched by span-name suffix so a renamed prefix still counts. One `put` of
 *   one key writes one row, so this is a floor for a put of several keys, and
 *   the printed count is operations, not rows. The scenario arms an alarm, so
 *   a run that sees no `setAlarm` span fails: the names have drifted.
 *
 * Run it after `pnpm run bundle:workers` in a baseline-upgrade PR. A plain
 * turn is the repeated unit, so a rise in either quantity per turn is the
 * failure: the probe fails when plain turns write more than
 * DSH_EDGE_COST_MAX_GROWTH (default 10 %) above the release in SQL rows or in
 * KV and alarm writes. Other steps are printed for review. Every step must
 * complete its turn, or the numbers would compare a failed run.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

const from = process.env.DSH_EDGE_COST_FROM
assert.ok(from, 'set DSH_EDGE_COST_FROM to a published dsh-edge version, for example 0.26.1')
const maxGrowth = Number(process.env.DSH_EDGE_COST_MAX_GROWTH ?? '0.1')
const OWNER_KEY = 'row-cost-probe-owner-key-32-bytes-long'
const work = mkdtempSync(join(tmpdir(), 'dsh-edge-row-cost-'))
const mock = await startMockDeepSeek()

execFileSync('npm', ['pack', `dsh-edge@${from}`, '--silent'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] })
execFileSync('tar', ['xzf', `dsh-edge-${from}.tgz`], { cwd: work })
const previousRoot = join(work, 'package')

/** Run the scenario on one build and return [step, rowsWritten, rowsRead] rows. */
async function measure(label, appDirectory) {
  const state = join(work, `state-${label}`)
  const options = appDirectory === undefined ? {} : { appDirectory }
  const boot = async name => {
    const config = join(work, `wrangler-${label}-${name}.json`)
    await writePrebuiltModeWranglerConfig('direct', config, appDirectory === undefined
      ? {}
      : { appDirectory, sourceConfigPath: join(appDirectory, 'wrangler.jsonc') })
    const worker = await unstable_dev(workerArtifactPath('direct', options), {
      config,
      persistTo: state,
      vars: { DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: mock.url, DSH_EDGE_ACCESS_KEY: OWNER_KEY },
      logLevel: 'error',
      experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false, watch: false },
    })
    const login = await worker.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `accessKey=${OWNER_KEY}`,
      redirect: 'manual',
    })
    const cookie = (login.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
    return { worker, cookie }
  }
  const query = async (worker, sql) => {
    const response = await worker.fetch('/cdn-cgi/local/explorer/api/local/observability/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql }),
    })
    return JSON.parse(await response.text()).result.rows
  }
  /** What every Durable Object storage call has cost so far: SQL rows, and KV and alarm write operations. */
  const totals = async worker => {
    const [[written, read]] = await query(worker, `SELECT
      sum(json_extract(attributes,'$."cloudflare.durable_object.response.rows_written"')),
      sum(json_extract(attributes,'$."cloudflare.durable_object.response.rows_read"'))
      FROM spans WHERE name = 'durable_object_storage_exec'`)
    const [[kv, armed]] = await query(worker, `SELECT
      count(*), sum(CASE WHEN name LIKE '%setAlarm' THEN 1 ELSE 0 END)
      FROM spans WHERE name LIKE 'durable_object%'
      AND (name LIKE '%put' OR name LIKE '%delete' OR name LIKE '%setAlarm' OR name LIKE '%deleteAlarm')`)
    return { written: written ?? 0, read: read ?? 0, kv, armed: armed ?? 0 }
  }
  /** Run one turn and require it to complete: a failed turn would write little and pass the comparison. */
  const completeTurn = async (worker, cookie, sessionId, message) => {
    const response = await worker.fetch(`/api/sessions/${sessionId}/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ message }),
    })
    assert.equal(response.status, 200, `${label}: turn "${message}" answered ${String(response.status)}`)
    const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    const end = events.at(-1)
    assert.equal(end?.type, 'turn/end', `${label}: turn "${message}" did not end`)
    assert.equal(end.data.reason.kind, 'completed', `${label}: turn "${message}" ended as ${JSON.stringify(end.data.reason)}`)
  }
  const rows = []
  let { worker, cookie } = await boot('first')
  try {
    const post = (path, payload) => worker.fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(payload),
    })
    const created = await (await post('/api/sessions', { title: 'row cost' })).json()
    const sessionId = created.session.id
    const step = async (name, message, settleMs = 400) => {
      const before = await totals(worker)
      await completeTurn(worker, cookie, sessionId, message)
      await new Promise(resolve => setTimeout(resolve, settleMs))
      const after = await totals(worker)
      rows.push([name, after.written - before.written, after.read - before.read, after.kv - before.kv])
    }
    await step('first turn (lazy initialization)', 'hello one')
    for (let index = 2; index <= 6; index += 1) await step('plain turn', `hello ${String(index)}`)
    // The child writes a file and its closing message wakes the parent; give both time.
    await step('subagent start, child done, parent woken', 'start a background subagent', 9_000)
    await step('bash tool turn', 'run the tool')
    await step('schedule_create turn', 'schedule once 3600')
    for (let index = 9; index <= 12; index += 1) await step('plain turn', `hello ${String(index)}`)
    // The schedule step arms an alarm; no span for it means the names above no longer match workerd's.
    assert.ok((await totals(worker)).armed > 0, `${label}: no setAlarm span was recorded, so alarm writes are not being counted`)
    await worker.stop()
    // A new Worker process on the same persisted state is a cold resume.
    ;({ worker, cookie } = await boot('cold'))
    const before = await totals(worker)
    await completeTurn(worker, cookie, sessionId, 'hello cold')
    await new Promise(resolve => setTimeout(resolve, 400))
    const after = await totals(worker)
    rows.push(['cold resume and one plain turn', after.written - before.written, after.read - before.read, after.kv - before.kv])
  } finally {
    await worker.stop()
  }
  return rows
}

try {
  const baseline = await measure('release', previousRoot)
  const candidate = await measure('candidate')
  const cell = ([, written, read, kv]) => `${String(written).padStart(5)} / ${String(read).padStart(5)} / ${String(kv).padEnd(3)}`
  process.stdout.write(`${'step'.padEnd(44)} ${`${from} sql written/read/kv`.padEnd(26)} candidate\n`)
  for (const [index, row] of baseline.entries()) {
    const next = candidate[index]
    const signed = value => `${value >= 0 ? '+' : ''}${String(value)}`
    process.stdout.write(`${row[0].padEnd(44)} ${cell(row)}   ${cell(next)}  ${signed(next[1] - row[1])} sql, ${signed(next[3] - row[3])} kv\n`)
  }
  const plain = (rows, column) => rows.filter(row => row[0] === 'plain turn').reduce((total, row) => total + row[column], 0)
  for (const [column, name] of [[1, 'SQL rows written'], [3, 'KV and alarm write operations']]) {
    const before = plain(baseline, column)
    const after = plain(candidate, column)
    assert.ok(after <= before * (1 + maxGrowth), `plain turns: ${name} ${String(after)} against ${String(before)} on ${from}, above the ${String(maxGrowth * 100)} % allowance`)
    process.stdout.write(`PASS plain turns: ${name} ${String(after)} against ${String(before)} on ${from} (allowance ${String(maxGrowth * 100)} %)\n`)
  }
} finally {
  await mock.close()
  rmSync(work, { recursive: true, force: true })
}
process.exit(0)
