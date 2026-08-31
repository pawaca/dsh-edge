/** Verify the pinned standalone dependency closure and its assembled artifacts. */

import { access, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import edgePackage from '../../package.json' with { type: 'json' }

const standaloneRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = resolve(standaloneRoot, '..')
const repoRoot = resolve(appRoot, '../..')
const standalonePackage = JSON.parse(await readFile(join(standaloneRoot, 'package.json'), 'utf8'))
const expectedBootShape = JSON.parse(
  await readFile(join(standaloneRoot, 'expected-boot-graph.json'), 'utf8'),
)
const patchAudit = JSON.parse(await readFile(join(standaloneRoot, 'patches', 'audit.json'), 'utf8'))
const targetVersion = edgePackage.dshEdge.upstreamVersion
const excludedClientPackages = [
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-client-ui-cordis',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-reference',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-session-log-export',
]

for (const [name, version] of Object.entries(standalonePackage.dependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/dsh-') && version !== targetVersion) {
    throw new Error(`${name} must use exact upstream version ${targetVersion}, found ${version}.`)
  }
}

const pinHook = await readFile(join(standaloneRoot, '.pnpmfile.cjs'), 'utf8')
if (!pinHook.includes("dependencies['@deepseek-ai/dsh-base']")) {
  throw new Error('The pnpm dependency-edge pin must derive from the exact base dependency.')
}

const lock = await readFile(join(standaloneRoot, 'pnpm-lock.yaml'), 'utf8')
const harnessVersions = new Set(
  [...lock.matchAll(/@deepseek-ai\/dsh-[^@:'"\s()]+@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)]
    .map(match => match[1]),
)
if (harnessVersions.size !== 1 || !harnessVersions.has(targetVersion)) {
  throw new Error(`Standalone lock mixes Harness versions: ${[...harnessVersions].join(', ') || 'none'}.`)
}

const workspace = await readFile(join(standaloneRoot, 'pnpm-workspace.yaml'), 'utf8')
if (!Array.isArray(patchAudit) || patchAudit.length === 0) {
  throw new Error('The retained patch audit must be a non-empty array.')
}
const registrations = [...workspace.matchAll(/^  '(@deepseek-ai\/[^']+)':\s+(patches\/\S+\.patch)$/gm)]
const registeredPatches = new Map(registrations.map(([, key, path]) => [key, path]))
if (registeredPatches.size !== registrations.length) {
  throw new Error('The workspace contains a duplicate retained patch registration.')
}
const auditedNames = new Set()
for (const entry of patchAudit) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Every retained patch audit entry must be an object.')
  }
  const { package: name, rationale, removeWhen } = entry
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/dsh-')) {
    throw new Error(`Invalid retained patch package: ${String(name)}.`)
  }
  if (auditedNames.has(name)) throw new Error(`Duplicate retained patch audit entry: ${name}.`)
  auditedNames.add(name)
  if (typeof rationale !== 'string' || rationale.trim() === '') {
    throw new Error(`Retained patch ${name} has no rationale.`)
  }
  if (typeof removeWhen !== 'string' || removeWhen.trim() === '') {
    throw new Error(`Retained patch ${name} has no removal condition.`)
  }
  const key = `${name}@${targetVersion}`
  const filename = `${name.replace('/', '__')}@${targetVersion}.patch`
  const registeredPath = registeredPatches.get(key)
  if (registeredPath !== `patches/${filename}`) {
    throw new Error(`Missing exact audited patch registration for '${key}': patches/${filename}.`)
  }
  const path = join(standaloneRoot, 'patches', filename)
  await access(path)
  if ((await stat(path)).size === 0) throw new Error(`Audited patch is empty: ${path}`)
}
if (registeredPatches.size !== patchAudit.length) {
  throw new Error(`Patch audit covers ${patchAudit.length} entries but the workspace registers ${registeredPatches.size}.`)
}
for (const key of registeredPatches.keys()) {
  const separator = key.lastIndexOf('@')
  const name = key.slice(0, separator)
  const version = key.slice(separator + 1)
  if (version !== targetVersion || !auditedNames.has(name)) {
    throw new Error(`Registered patch is not covered by the ${targetVersion} audit: ${key}.`)
  }
}

for (const mode of ['direct', 'isolated']) {
  const path = join(standaloneRoot, 'worker', mode, 'index.js')
  await access(path)
  if ((await stat(path)).size === 0) throw new Error(`Standalone ${mode} Worker is empty.`)
  const worker = await readFile(path, 'utf8')
  if (!worker.includes(`dsh-edge@${edgePackage.version}/${mode}`)) {
    throw new Error(`Standalone ${mode} Worker has the wrong deployment identity.`)
  }
}

const webRoot = join(standaloneRoot, 'dist')
const index = await readFile(join(webRoot, 'index.html'), 'utf8')
if (!index.includes('window.__ModuleLoader__=')) {
  throw new Error('Standalone Web shell omitted the upstream module-loader bootstrap facade.')
}
const bootMatch = index.match(/globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/s)
if (bootMatch === null) throw new Error('Standalone Web shell has no boot manifest.')
const boot = JSON.parse(bootMatch[1])
if (!Array.isArray(boot.entries) || boot.entries.length !== expectedBootShape.length) {
  throw new Error(
    `Expected ${String(expectedBootShape.length)} reviewed ${targetVersion} client plugins, found ${String(boot.entries?.length)}.`,
  )
}
const clientIds = new Set(boot.entries.map(entry => entry.id))
if (!clientIds.has('dsh-edge-client-ui')) {
  throw new Error('Standalone Web shell omitted the Edge client plugin.')
}
for (const name of ['@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-runtime']) {
  const entry = boot.entries.find(candidate => candidate.id === name)
  if (entry === undefined || !index.includes(`<script src="${entry.url}"></script>`)) {
    throw new Error(`Standalone Web shell omitted the parser-blocking preload for ${name}.`)
  }
}
for (const name of excludedClientPackages) {
  if (clientIds.has(name)) throw new Error(`Standalone Web shell included unsupported plugin ${name}.`)
}
for (const entry of boot.entries) {
  await access(join(webRoot, 'plugins', entry.id, 'client.js'))
}
if (JSON.stringify(bootShape(boot)) !== JSON.stringify(expectedBootShape)) {
  throw new Error(`Standalone Web boot graph differs from the reviewed ${targetVersion} contract.`)
}
const edgeClientBundle = await readFile(join(webRoot, 'plugins', 'dsh-edge-client-ui', 'client.js'), 'utf8')
if (/require\(["']compare-versions["']\)/u.test(edgeClientBundle)) {
  throw new Error('Edge client left compare-versions outside the standalone bundle.')
}
if (!edgeClientBundle.includes('//#region \\0dsh-edge-css:src/client/')) {
  throw new Error('Edge client CSS identity is not checkout-independent.')
}
if (edgeClientBundle.includes(repoRoot) || edgeClientBundle.includes(standaloneRoot)) {
  throw new Error('Edge client bundle contains an absolute checkout path.')
}
const sourceMaps = (await filesUnder(webRoot)).filter(path => path.endsWith('.map'))
if (sourceMaps.length > 0) {
  throw new Error(`Standalone Web assets contain source maps: ${sourceMaps.join(', ')}`)
}

console.log(
  `Verified standalone Harness ${targetVersion}: ${patchAudit.length} patches, ${boot.entries.length} client plugins, and both Worker modes.`,
)

async function filesUnder(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else files.push(relative(repoRoot, path))
  }
  return files
}

function bootShape(graph) {
  return graph.entries.map(entry => ({
    id: entry.id,
    ...(entry.inject === undefined ? {} : { inject: entry.inject }),
    ...(entry.immediately === undefined ? {} : { immediately: entry.immediately }),
    ...(entry.external === undefined ? {} : { external: entry.external }),
  }))
}
