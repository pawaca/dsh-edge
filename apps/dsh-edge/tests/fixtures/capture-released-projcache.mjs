/**
 * Capture the `session_projcache` KV medium exactly as a published dsh-edge
 * release writes it, for the released-state upgrade fixture.
 *
 * Usage (from apps/dsh-edge, with the release unpacked via `npm pack dsh-edge@<version>`):
 *
 *   node tests/fixtures/capture-released-projcache.mjs <unpacked-package-dir> <output.json>
 *
 * Runs the release's own direct Worker artifact against the mock DeepSeek
 * server, creates one session, completes one turn (which checkpoints the
 * projection cache), then reads the `dsh-kv:session_projcache:` keys back
 * through a dump-only Durable Object over the same persisted state. No
 * candidate runtime code is involved, so the output is a faithful medium of
 * that release's Harness baseline.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unstable_dev } from 'wrangler'
import { writePrebuiltModeWranglerConfig } from '../../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './mock-deepseek.mjs'

const [releasedDirectory, output] = process.argv.slice(2)
if (releasedDirectory === undefined || output === undefined) {
  process.stderr.write('Usage: node tests/fixtures/capture-released-projcache.mjs <unpacked-package-dir> <output.json>\n')
  process.exit(2)
}
const released = resolve(releasedDirectory)
const persist = mkdtempSync(join(tmpdir(), 'dsh-edge-projcache-capture-'))
const config = join(persist, 'wrangler-direct.json')
await writePrebuiltModeWranglerConfig('direct', config, {
  appDirectory: released,
  sourceConfigPath: join(released, 'wrangler.jsonc'),
})
const mock = await startMockDeepSeek()
const ACCESS_KEY = 'integration-owner-access-key-32-bytes'
const devOptions = {
  config,
  env: '',
  persistTo: persist,
  logLevel: 'error',
  experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false, watch: false },
}

const worker = await unstable_dev(join(released, 'worker/direct/index.js'), {
  ...devOptions,
  vars: {
    DEEPSEEK_API_KEY: 'integration-test-key',
    DEEPSEEK_BASE_URL: mock.url,
    DEEPSEEK_SEARCH_BASE_URL: `${mock.url}/anthropic/v1`,
    DEEPSEEK_MAX_OUTPUT_TOKENS: '16384',
    DEEPSEEK_MODEL: 'deepseek-v4-pro',
    DEEPSEEK_REASONING_EFFORT: 'high',
    DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS: '180000',
    DSH_EDGE_MAX_COMMAND_TIMEOUT_MS: '240000',
    DSH_EDGE_ACCESS_KEY: ACCESS_KEY,
  },
})
try {
  const login = await fetch(`http://${worker.address}:${worker.port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessKey: ACCESS_KEY }).toString(),
    redirect: 'manual',
  })
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  if (login.status !== 303 || cookie === undefined) throw new Error(`owner login failed: ${login.status}`)
  const request = (path, init = {}) => worker.fetch(`http://dsh-edge.test${path}`, {
    ...init,
    headers: { ...init.headers ?? {}, cookie },
  })
  const created = await request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Captured released projection cache' }),
  })
  if (created.status !== 201) throw new Error(`session create failed: ${created.status}`)
  const { session } = await created.json()
  const turn = await request(`/api/sessions/${session.id}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'capture projection cache' }),
  })
  const events = await turn.text()
  if (turn.status !== 200 || !events.includes('"type":"turn/end"')) {
    throw new Error(`turn did not complete: ${turn.status}`)
  }
  // Let the post-turn checkpoint writes settle before the Worker stops.
  await new Promise(resolve => setTimeout(resolve, 1_500))
} finally {
  await worker.stop()
}

const dump = await unstable_dev(new URL('./dump-projcache-worker.mjs', import.meta.url).pathname, devOptions)
try {
  const response = await dump.fetch('http://dsh-edge.test/api/dump')
  if (response.status !== 200) throw new Error(`dump failed: ${response.status}`)
  const { entries } = await response.json()
  writeFileSync(output, `${JSON.stringify(entries, null, 2)}\n`)
  process.stdout.write(`captured ${Object.keys(entries).length} session_projcache entries to ${output}\n`)
} finally {
  await dump.stop()
  await mock.close()
}
