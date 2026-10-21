/**
 * What a file upload costs in Durable Object storage, as the Workers runtime
 * counts it (the SQL spans workerd records, as tests/row-cost.probe.mjs reads
 * them), not as Node SQLite reports it. Uploaded bytes land in the
 * SQLite-backed workspace VFS one 512 KiB chunk at a time, and each chunk
 * costs a few rows (the content-addressed blob and its bytes, the chunk link,
 * and its revision bookkeeping), so rows written must grow with chunks and
 * nothing else: a successful upload, a repeated upload of the same file and
 * name (one rename over the stored object), and an upload refused at the
 * 64 MiB limit each stay within a fixed overhead of their chunks.
 *
 * Measured locally with @cloudflare/computer 0.3.1: about 46 rows for 1 MiB,
 * 78 for 4 MiB (about 5.3 per chunk), 65 for the same 4 MiB again, and 259
 * for a 65 MiB stream refused at the limit, so a 64 MiB upload is about 720
 * rows, under 1 % of the Workers Free daily allowance of 100,000.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

const MIB = 1024 * 1024
const CHUNK = 512 * 1024
// Rows per 512 KiB chunk (measured about 5.3) and beyond the chunks: the staged
// inode, its dirents, the content address directories, the rename, and
// revision bookkeeping (measured about 35).
const ROWS_PER_CHUNK = 6
const OVERHEAD_ROWS = 50
// Rows read per chunk and beyond the chunks (measured about 106 for 2 chunks,
// 110 for 8, 281 for a refused 130).
const READS_PER_CHUNK = 3
const READ_OVERHEAD_ROWS = 150

it('writes rows in proportion to uploaded chunks, including repeats and refusals', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-upload-cost-'))
  const config = join(state, 'wrangler.json')
  const ownerKey = 'upload-cost-fixture-owner-key-32-chars'
  const mock = await startMockDeepSeek()
  let worker
  try {
    await writePrebuiltModeWranglerConfig('direct', config)
    worker = await unstable_dev(workerArtifactPath('direct'), {
      config, persistTo: state,
      vars: { DSH_EDGE_ACCESS_KEY: ownerKey, DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: mock.url },
      logLevel: 'error',
      experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false, watch: false },
    })
    const login = await worker.fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `accessKey=${ownerKey}`, redirect: 'manual',
    })
    const cookie = (login.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
    const query = async sql => JSON.parse(await (await worker.fetch('/cdn-cgi/local/explorer/api/local/observability/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql }),
    })).text()).result.rows
    const totals = async () => {
      const [[written, read]] = await query(`SELECT
        sum(json_extract(attributes,'$."cloudflare.durable_object.response.rows_written"')),
        sum(json_extract(attributes,'$."cloudflare.durable_object.response.rows_read"'))
        FROM spans WHERE name = 'durable_object_storage_exec'`)
      return { written: written ?? 0, read: read ?? 0 }
    }
    /** Wait until the span totals stop moving, so a step includes all it wrote. */
    const quiet = async () => {
      let last = JSON.stringify(await totals())
      for (let deadline = Date.now() + 60_000; Date.now() < deadline;) {
        await new Promise(resolve => setTimeout(resolve, 600))
        const next = JSON.stringify(await totals())
        if (next === last) return
        last = next
      }
      throw new Error('storage activity did not settle')
    }
    const rpc = async (method, payload) => (await worker.fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    })).json()
    const sessionId = (await rpc('session.create', {})).result.value.sessionId
    const upload = async (name, body) => (await worker.fetch(`/api/session/uploadFileBinary?sessionId=${sessionId}&name=${name}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie }, body, duplex: 'half',
    })).json()
    const file = bytes => Uint8Array.from({ length: bytes }, (_, index) => (index * 31 + 7) % 251)
    const measured = {}
    const step = async (name, run) => {
      await quiet()
      const before = await totals()
      await run()
      await quiet()
      const after = await totals()
      measured[name] = { written: after.written - before.written, read: after.read - before.read }
    }

    // The first upload resumes the cold session; measure uploads after it.
    await step('session resume and a small upload', async () => expect((await upload('warm.txt', 'warm')).ok).toBe(true))
    await step('1 MiB upload', async () => expect((await upload('one.bin', file(MIB))).ok).toBe(true))
    await step('4 MiB upload', async () => expect((await upload('four.bin', file(4 * MIB))).ok).toBe(true))
    await step('same 4 MiB file and name again', async () => expect((await upload('four.bin', file(4 * MIB))).ok).toBe(true))
    await step('65 MiB refused at the limit', async () => {
      let sent = 0
      const body = new ReadableStream({
        pull(controller) {
          if (sent++ >= 65) controller.close()
          else controller.enqueue(new Uint8Array(MIB))
        },
      })
      expect((await upload('big.bin', body)).ok).toBe(false)
    })
    // Retained data: with 30 more stored uploads, a 1 MiB upload must read no
    // more than with few, so reads do not scale with what is already stored.
    for (let index = 0; index < 30; index += 1) expect((await upload(`kept-${String(index)}.txt`, `kept ${String(index)}`)).ok).toBe(true)
    await step('1 MiB upload with 30 more files stored', async () => expect((await upload('one-later.bin', file(MIB))).ok).toBe(true))
    console.log(JSON.stringify(measured, null, 2))

    const chunks = bytes => Math.ceil(bytes / CHUNK)
    const bound = bytes => ROWS_PER_CHUNK * chunks(bytes) + OVERHEAD_ROWS
    expect(measured['1 MiB upload'].written).toBeLessThanOrEqual(bound(MIB))
    expect(measured['4 MiB upload'].written).toBeLessThanOrEqual(bound(4 * MIB))
    // A repeat writes the file once more and renames it over the stored copy.
    expect(measured['same 4 MiB file and name again'].written).toBeLessThanOrEqual(bound(4 * MIB))
    // A refusal stages chunks up to the limit and removes the staged file.
    expect(measured['65 MiB refused at the limit'].written).toBeLessThanOrEqual(bound(65 * MIB))
    // Reads follow the same shape (measured about 106 for 1 MiB, 110 for
    // 4 MiB, 135 for the repeat, 281 for the refusal).
    const readBound = bytes => READS_PER_CHUNK * chunks(bytes) + READ_OVERHEAD_ROWS
    expect(measured['1 MiB upload'].read).toBeLessThanOrEqual(readBound(MIB))
    expect(measured['4 MiB upload'].read).toBeLessThanOrEqual(readBound(4 * MIB))
    expect(measured['same 4 MiB file and name again'].read).toBeLessThanOrEqual(readBound(4 * MIB))
    expect(measured['65 MiB refused at the limit'].read).toBeLessThanOrEqual(readBound(65 * MIB))
    expect(measured['1 MiB upload with 30 more files stored'].read).toBeLessThanOrEqual(measured['1 MiB upload'].read + 20)
    expect(measured['1 MiB upload with 30 more files stored'].written).toBeLessThanOrEqual(measured['1 MiB upload'].written + 10)
    // Growth is per chunk: three more MiB cost at most six chunks' rows.
    expect(measured['4 MiB upload'].written - measured['1 MiB upload'].written).toBeLessThanOrEqual(ROWS_PER_CHUNK * chunks(3 * MIB))
  } finally {
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
