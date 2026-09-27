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
import { LIGHT_SHELL_SAMPLES, LIGHT_SHELL_SETUP } from './fixtures/light-shell-samples.mjs'
import { ROUTING_CORPUS, ROUTING_CORPUS_SETUP } from './fixtures/routing-corpus.mjs'

const ACCESS_KEY = 'container-integration-owner-key-32b'
const FILES = 100
// Measured at about 6 stored rows per new small file (node, dirent, blob,
// chunk, manifest, change log).
const MAX_ROWS_PER_FILE = 10

try {
  execFileSync('docker', ['info'], { stdio: 'ignore' })
} catch {
  // CI sets DSH_EDGE_REQUIRE_DOCKER so a missing engine fails rather than
  // reporting a pass that ran nothing; local runs without Docker still skip.
  if (process.env.DSH_EDGE_REQUIRE_DOCKER === '1') {
    process.stderr.write('Container integration requires Docker, but no Docker engine is reachable.\n')
    process.exit(1)
  }
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
  await startWorker(persistTo)

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

  // A routing miss that changed nothing reruns in the container transparently;
  // one that already wrote files is reported instead of rerun.
  const rerun = await exec('d=etc; cat /"$d"/hostname')
  assert.equal(rerun.status, 'completed', rerun.stderr)
  assert.equal(rerun.runtime, 'container')
  assert.equal(rerun.retriedFromLight, true)
  assert.notEqual(rerun.stdout, '')
  const wrote = await exec('d=etc; echo x > wrote.txt; cat /"$d"/hostname')
  assert.equal(wrote.runtime, 'light')
  assert.equal(wrote.lightShellMiss, true)
  assert.equal(wrote.retriedFromLight, undefined)
  assert.equal((await exec('cat wrote.txt')).stdout, 'x\n')

  // A silent reach for a container-only path (no error, just "missing") is
  // caught at the filesystem boundary and rerun in the container too.
  const probe = await exec('d=etc; test -f /"$d"/os-release && echo linux || echo missing')
  assert.equal(probe.stdout, 'linux\n')
  assert.equal(probe.retriedFromLight, true)
  // Concurrently, a silent probe must still rerun while another light command
  // writes the workspace: light commands take turns, so each owns its signals.
  const [raced] = await Promise.all([
    exec('d=etc; test -f /"$d"/os-release && echo linux || echo missing'),
    exec('sleep 1; echo x > raced.txt'),
  ])
  assert.equal(raced.stdout, 'linux\n')
  assert.equal(raced.retriedFromLight, true)
  // A link into the container's filesystem crosses too; creating it wrote a
  // file, so the command is reported rather than rerun.
  const linked = await exec('d=etc; ln -s /"$d"/os-release os; test -f os && echo linux || echo missing')
  assert.equal(linked.runtime, 'light')
  assert.equal(linked.lightShellMiss, true)


  // jq and the compressors are container-only programs: routed there, and
  // present in the image.
  const tools = await exec(`echo '{"v":1}' | jq .v && echo x | xz | xz -d && echo x | bzip2 | bzip2 -d && echo x | zstd | zstd -d`)
  assert.equal(tools.status, 'completed', tools.stderr)
  assert.equal(tools.stdout, '1\nx\nx\nx\n')
  assert.equal(tools.runtime, 'container')

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

  // Routing checks run on fresh state so their files never skew the storage
  // measurement above.
  await startWorker(join(scratch, 'routing-state'))
  // Every command routing keeps light must stay light: no rerun, no miss.
  // A false boundary crossing (say, a new PATH probe) would fail here.
  const samplesCwd = '/workspace/light-shell-samples'
  assert.equal((await exec(LIGHT_SHELL_SETUP, false, samplesCwd)).status, 'completed')
  const rerouted = []
  for (const [name, command] of Object.entries(LIGHT_SHELL_SAMPLES)) {
    const sample = await exec(command, false, samplesCwd)
    if (sample.runtime !== 'light' || sample.retriedFromLight || sample.lightShellMiss) {
      rerouted.push(`${name}: runtime=${sample.runtime} retried=${sample.retriedFromLight} miss=${sample.lightShellMiss}`)
    }
  }
  assert.deepEqual(rerouted, [], 'light-shell samples left the light shell')

  // Differential corpus: automatic routing (including any rerun) must match
  // a forced Linux run, or say it could not rerun a command that wrote files.
  const differing = []
  for (const [index, command] of ROUTING_CORPUS.entries()) {
    const auto = `/workspace/corpus/${index}-auto`
    const linux = `/workspace/corpus/${index}-linux`
    for (const dir of [auto, linux]) {
      const setup = await exec(ROUTING_CORPUS_SETUP, true, dir)
      assert.equal(setup.status, 'completed', `corpus setup: ${setup.stderr}`)
    }
    const routed = await exec(command, false, auto)
    const forced = await exec(command, true, linux)
    // Each run has its own directory; compare everything else, stderr included.
    const normalize = text => text.replaceAll(auto, '<dir>').replaceAll(linux, '<dir>')
      .replaceAll(`${index}-auto`, '<dir>').replaceAll(`${index}-linux`, '<dir>')
    const same = routed.exitCode === forced.exitCode && normalize(routed.stdout) === normalize(forced.stdout)
      && normalize(routed.stderr) === normalize(forced.stderr)
    if (!same && routed.lightShellMiss !== true) {
      differing.push(`${command}\n  auto:  ${routed.runtime}${routed.retriedFromLight ? ' (rerun)' : ''} `
        + `exit=${routed.exitCode} ${JSON.stringify(routed.stdout.slice(0, 80))} ${JSON.stringify(routed.stderr.slice(0, 120))}`
        + `\n  linux: exit=${forced.exitCode} ${JSON.stringify(forced.stdout.slice(0, 80))} ${JSON.stringify(forced.stderr.slice(0, 120))}`)
    }
  }
  assert.deepEqual(differing, [], 'automatic routing differs from a forced Linux run')

  // Settings apply to the next command without a restart.
  assert.deepEqual((await json('/api/runtime')).settings, { bashRouting: 'auto', containerSleepMinutes: 10 })
  await putRuntime({ bashRouting: 'light' })
  const forcedLight = await exec('node -v')
  assert.equal(forcedLight.runtime, 'light')
  assert.notEqual(forcedLight.exitCode, 0)
  await putRuntime({ bashRouting: 'container' })
  assert.equal((await exec('echo hi')).runtime, 'container')
  await putRuntime({ bashRouting: 'auto', containerSleepMinutes: 5 })
  assert.equal((await exec('echo hi')).runtime, 'light')

  // Sleep now stops the idle container; the next Linux command wakes it.
  const status = await json('/api/runtime')
  assert.equal(status.container.running, true)
  assert.equal(status.container.runningCommands, 0)
  const stopped = await fetch(`http://${worker.address}:${worker.port}/api/runtime/container/stop`, {
    method: 'POST',
    headers: { cookie },
  })
  assert.equal(stopped.status, 200)
  assert.equal((await stopped.json()).outcome, 'stopped')
  assert.equal((await json('/api/runtime')).container.running, false)
  assert.equal((await exec('uname -s')).stdout, 'Linux\n')

  // The first command after a restart routes by the saved policy, not the default.
  await putRuntime({ bashRouting: 'light' })
  await worker.stop()
  await startWorker(join(scratch, 'routing-state'))
  assert.equal((await exec('node -v')).runtime, 'light')
  process.stdout.write('dsh-edge container integration passed\n')
} finally {
  await worker?.stop()
  rmSync(scratch, { recursive: true, force: true })
}

async function startWorker(state) {
  worker = await unstable_dev(workerArtifactPath('container'), {
    config,
    env: 'container',
    persistTo: state,
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
}

async function exec(command, linux = false, cwd = undefined) {
  const response = await fetch(`http://${worker.address}:${worker.port}/api/workspace/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ command, ...linux ? { linux: true } : {}, ...cwd === undefined ? {} : { cwd } }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}

function containersRunning() {
  const names = execFileSync('docker', ['ps', '--format', '{{.Image}}'], { encoding: 'utf8' })
  return names.split('\n').filter(name => name.includes('dshedgeinstance')).length
}

async function putRuntime(settings) {
  const response = await fetch(`http://${worker.address}:${worker.port}/api/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(settings),
  })
  assert.equal(response.status, 200, await response.clone().text())
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
