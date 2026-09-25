/**
 * Local Container runtime check. Needs a Docker-compatible engine; it is not
 * part of the default CI matrix because it builds the Linux image.
 *
 * Covers the real computerd round trip (the container dials back to the
 * Durable Object with its bearer secret) and bounds the SQLite rows a burst of
 * container-created files leaves behind in the workspace tables. This bounds
 * storage growth per file; it does not count transient writes.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'

const ACCESS_KEY = 'container-integration-owner-key-32b'
const FILES = 100
// Measured at about 6 stored rows per new small file (node, dirent, blob,
// chunk, manifest, change log).
const MAX_ROWS_PER_FILE = 10

try {
  execFileSync('docker', ['info'], { stdio: 'ignore' })
} catch {
  process.stdout.write('Skipping container integration: no Docker engine is reachable.\n')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-edge-container-'))
const config = join(scratch, 'wrangler.json')
const persistTo = join(scratch, 'state')
let worker
let cookie
try {
  await writePrebuiltModeWranglerConfig('container', config, { localContainerImage: true })
  worker = await unstable_dev(workerArtifactPath('container'), {
    config,
    env: 'container',
    persistTo,
    vars: {
      DEEPSEEK_API_KEY: 'container-integration-key',
      DSH_EDGE_ACCESS_KEY: ACCESS_KEY,
    },
    logLevel: 'error',
    experimental: {
      disableExperimentalWarning: true,
      showInteractiveDevSession: false,
      watch: false,
      enableContainers: true,
    },
  })
  const login = await fetch(`http://${worker.address}:${worker.port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessKey: ACCESS_KEY }).toString(),
    redirect: 'manual',
  })
  cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie)

  const health = await json('/api/health')
  assert.equal(health.shell, 'linux-container')

  // File and text work stays in the lightweight shell and never starts the container.
  const light = await exec('mkdir -p notes && echo hi > notes/a.txt && ls notes')
  assert.equal(light.stdout, 'a.txt\n')
  assert.equal(light.runtime, 'light')
  assert.equal(containersRunning(), 0, 'a light-shell command started the container')

  // Commands that need Linux are routed to the container, and it sees the
  // lightweight shell's writes.
  const linux = await exec('uname -s && node -v && cat notes/a.txt')
  assert.equal(linux.status, 'completed', linux.stderr)
  assert.match(linux.stdout, /^Linux\nv22\.[^\n]*\nhi\n$/u)
  assert.equal(linux.runtime, 'container')
  assert.equal(typeof linux.queuedMs, 'number')

  const burst = await exec(`mkdir -p burst && for i in $(seq ${FILES}); do echo "file $i" > burst/f$i; done`, true)
  assert.equal(burst.status, 'completed', burst.stderr)
  assert.equal(burst.runtime, 'container')
  const read = await exec('cat burst/f7')
  assert.equal(read.stdout, 'file 7\n')
  assert.equal(read.runtime, 'light')
  const file = await fetch(`http://${worker.address}:${worker.port}/api/workspace/file?path=/workspace/burst/f42`, {
    headers: { cookie },
  })
  assert.equal(await file.text(), 'file 42\n')
  await worker.stop()
  worker = undefined

  const rows = workspaceRows(persistTo)
  const perFile = rows / FILES
  process.stdout.write(`container storage: ${rows} workspace rows for ${FILES} files (${perFile.toFixed(1)}/file)\n`)
  assert.ok(perFile <= MAX_ROWS_PER_FILE, `Container sync stored ${perFile.toFixed(1)} rows per file`)
  process.stdout.write('dsh-edge container integration passed\n')
} finally {
  await worker?.stop()
  rmSync(scratch, { recursive: true, force: true })
}

async function exec(command, linux = false) {
  const response = await fetch(`http://${worker.address}:${worker.port}/api/workspace/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ command, ...linux ? { linux: true } : {} }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}

function containersRunning() {
  const names = execFileSync('docker', ['ps', '--format', '{{.Image}}'], { encoding: 'utf8' })
  return names.split('\n').filter(name => name.includes('dshedgeinstance')).length
}

async function json(path) {
  const response = await fetch(`http://${worker.address}:${worker.port}${path}`, { headers: { cookie } })
  assert.equal(response.status, 200)
  return response.json()
}

/** Rows across the Computer VFS tables of the Durable Object that owns the workspace. */
function workspaceRows(root) {
  let total = 0
  for (const path of sqliteFiles(root)) {
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vfs\\_%' ESCAPE '\\'",
      ).all()
      for (const { name } of tables) {
        total += Number(database.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n)
      }
    } finally {
      database.close()
    }
  }
  assert.ok(total > 0, 'No workspace rows were persisted.')
  return total
}

function sqliteFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.sqlite')) files.push(join(entry.parentPath, entry.name))
  }
  return files
}
