/**
 * Reclaim deleted workspace content in the Workers runtime (#358): write a
 * file to keep and one to delete, delete it, age the stored content past the
 * grace and clear the sweep record in the persisted SQLite file, restart, and
 * check that the next sweep freed the deleted file's bytes and only those.
 *
 *   node tests/vfs-reclaim.probe.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'

const mode = process.env.DSH_EDGE_PROBE_MODE ?? 'isolated'
const ACCESS_KEY = 'vfs-reclaim-probe-owner-key-32-b!'
const DAY = 24 * 60 * 60 * 1000
const work = mkdtempSync(join(tmpdir(), 'dsh-edge-vfs-reclaim-'))
const state = join(work, 'state')
let worker
let cookie

let starts = 0
async function start() {
  const config = join(work, `wrangler-${String(++starts)}.json`)
  await writePrebuiltModeWranglerConfig(mode, config, {})
  worker = await unstable_dev(workerArtifactPath(mode), {
    config, env: mode === 'direct' ? '' : mode, persistTo: state,
    vars: { DEEPSEEK_API_KEY: 'vfs-reclaim-probe-key', DSH_EDGE_ACCESS_KEY: ACCESS_KEY },
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

const file = (path, method, body) => request(`/api/workspace/file?path=${encodeURIComponent(path)}`, { method, body })

/** Run a command, which opens the resident workspace and with it the daily sweep. */
async function touchWorkspace() {
  const response = await request('/api/workspace/exec', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'true' }),
  })
  assert.equal(response.status, 200, await response.clone().text())
}

/** The instance's Durable Object SQLite file: the one holding the workspace VFS. */
function instanceDatabase() {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.sqlite')) files.push(path)
    }
  }
  walk(state)
  const matches = files.filter((path) => {
    const db = new DatabaseSync(path, { readOnly: true })
    try { return db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vfs_blobs'").get() !== undefined } finally { db.close() }
  })
  assert.equal(matches.length, 1, `one instance database, found ${matches.length}`)
  return matches[0]
}

function stored(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare('SELECT count(*) AS blobs, coalesce(sum(length(bytes)), 0) AS bytes FROM vfs_blob_bytes').get()
  } finally { db.close() }
}

// The owner file route takes text up to 1 MiB; distinct lines keep the two
// files from sharing a chunk.
const lines = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix} line ${String(i)}\n`).join('')
const kept = lines('kept', 20_000)
const removed = lines('removed', 50_000)
const size = text => new TextEncoder().encode(text).byteLength
try {
  await start()
  await touchWorkspace()
  assert.equal((await file('/workspace/kept.bin', 'PUT', kept)).status, 200)
  assert.equal((await file('/workspace/removed.bin', 'PUT', removed)).status, 200)
  assert.equal((await file('/workspace/removed.bin', 'DELETE')).status, 200)
  await worker.stop()

  const database = instanceDatabase()
  const before = stored(database)
  assert.ok(before.bytes >= size(kept) + size(removed), `deleted content is still stored: ${JSON.stringify(before)}`)
  {
    // Age every blob past the grace and make the next start sweep at once.
    const db = new DatabaseSync(database)
    try {
      db.prepare('UPDATE vfs_blobs SET last_seen = last_seen - ?').run(2 * DAY)
      const deleted = db.prepare("DELETE FROM _cf_KV WHERE key = 'dsh-edge:spill-swept-at'").run().changes
      assert.equal(deleted, 1, 'the first start recorded a sweep')
    } finally { db.close() }
  }

  await start()
  await touchWorkspace()
  await new Promise(resolve => setTimeout(resolve, 2_000))
  await worker.stop()
  const after = stored(database)
  assert.equal(before.bytes - after.bytes, size(removed), `freed exactly the deleted file: ${JSON.stringify({ before, after })}`)
  console.log(`PASS freed ${String(before.bytes - after.bytes)} bytes in ${String(before.blobs - after.blobs)} blobs (${mode})`)

  await start()
  const read = await file('/workspace/kept.bin', 'GET')
  assert.equal(read.status, 200)
  assert.equal(await read.text(), kept)
  await touchWorkspace()
  console.log('PASS the kept file reads back whole and commands still run')
} finally {
  await worker?.stop()
  rmSync(work, { recursive: true, force: true })
}
