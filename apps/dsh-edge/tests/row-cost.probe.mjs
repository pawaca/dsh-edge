/**
 * Compare Durable Object SQL cost between a published release and this
 * candidate, on the same scripted conversation: the rows each turn writes and
 * reads, as the Workers runtime counts them (`rows_written` / `rows_read` on
 * every SQL span workerd records), not as Node SQLite reports them.
 *
 *   DSH_EDGE_COST_FROM=0.26.1 node tests/row-cost.probe.mjs
 *
 * Run it after `pnpm run bundle:workers` in a baseline-upgrade PR. A plain
 * turn is the repeated unit, so a rise in its rows per turn is the failure:
 * the probe fails when a plain turn writes more than DSH_EDGE_COST_MAX_GROWTH
 * (default 10 %) above the release. Other steps are printed for review.
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
  /** Rows every Durable Object SQL statement has written and read so far. */
  const totals = async worker => {
    const sql = `SELECT sum(json_extract(attributes,'$."cloudflare.durable_object.response.rows_written"')),
      sum(json_extract(attributes,'$."cloudflare.durable_object.response.rows_read"'))
      FROM spans WHERE name = 'durable_object_storage_exec'`
    const response = await worker.fetch('/cdn-cgi/local/explorer/api/local/observability/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql }),
    })
    const [written, read] = JSON.parse(await response.text()).result.rows[0]
    return { written: written ?? 0, read: read ?? 0 }
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
      await (await post(`/api/sessions/${sessionId}/turn`, { message })).text()
      await new Promise(resolve => setTimeout(resolve, settleMs))
      const after = await totals(worker)
      rows.push([name, after.written - before.written, after.read - before.read])
    }
    await step('first turn (lazy initialization)', 'hello one')
    for (let index = 2; index <= 6; index += 1) await step('plain turn', `hello ${String(index)}`)
    // The child writes a file and its closing message wakes the parent; give both time.
    await step('subagent start, child done, parent woken', 'start a background subagent', 9_000)
    await step('bash tool turn', 'run the tool')
    await step('schedule_create turn', 'schedule once 3600')
    for (let index = 9; index <= 12; index += 1) await step('plain turn', `hello ${String(index)}`)
    await worker.stop()
    // A new Worker process on the same persisted state is a cold resume.
    ;({ worker, cookie } = await boot('cold'))
    const before = await totals(worker)
    await (await worker.fetch(`/api/sessions/${sessionId}/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ message: 'hello cold' }),
    })).text()
    await new Promise(resolve => setTimeout(resolve, 400))
    const after = await totals(worker)
    rows.push(['cold resume and one plain turn', after.written - before.written, after.read - before.read])
  } finally {
    await worker.stop()
  }
  return rows
}

try {
  const baseline = await measure('release', previousRoot)
  const candidate = await measure('candidate')
  const cell = ([, written, read]) => `${String(written).padStart(5)} / ${String(read).padEnd(5)}`
  process.stdout.write(`${'step'.padEnd(44)} ${`${from} written/read`.padEnd(18)} candidate\n`)
  for (const [index, row] of baseline.entries()) {
    const next = candidate[index]
    process.stdout.write(`${row[0].padEnd(44)} ${cell(row)}      ${cell(next)}  ${next[1] - row[1] >= 0 ? '+' : ''}${String(next[1] - row[1])} written\n`)
  }
  const plain = rows => rows.filter(row => row[0] === 'plain turn').map(row => row[1])
  const sum = values => values.reduce((total, value) => total + value, 0)
  const before = sum(plain(baseline))
  const after = sum(plain(candidate))
  assert.ok(after <= before * (1 + maxGrowth), `plain turns write ${String(after)} rows against ${String(before)} on ${from}, above the ${String(maxGrowth * 100)} % allowance`)
  process.stdout.write(`PASS plain turns write ${String(after)} rows against ${String(before)} on ${from} (allowance ${String(maxGrowth * 100)} %)\n`)
} finally {
  await mock.close()
  rmSync(work, { recursive: true, force: true })
}
process.exit(0)
