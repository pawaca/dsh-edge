/** Assemble Edge Web assets entirely from the pinned published upstream packages. */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientModuleRegistry, bootInjections, orderByModuleGraph } from '@deepseek-ai/dsh-client-modules'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'

const standaloneRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = resolve(standaloneRoot, '..')
const repoRoot = resolve(appRoot, '../..')
const standaloneRequire = createRequire(join(standaloneRoot, 'package.json'))
const basePackagePath = standaloneRequire.resolve('@deepseek-ai/dsh-base/package.json')
const webAppPackagePath = standaloneRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
const shellPackagePath = standaloneRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')
const packageResolvers = [
  standaloneRequire,
  createRequire(basePackagePath),
  createRequire(webAppPackagePath),
]
const shellDist = join(dirname(shellPackagePath), 'dist')
const outputRoot = join(standaloneRoot, 'dist')
const deploymentPatches = [
  join(dirname(basePackagePath), 'cordis.patch.yml'),
  join(dirname(webAppPackagePath), 'cordis.patch.yml'),
]
const edgeClientPackagePath = join(repoRoot, 'packages/client/ui-edge/package.json')
const edgeClientBundlePath = join(standaloneRoot, 'edge-client/client.js')
const edgeClientPackages = new Map([
  ['dsh-edge-client-ui', {
    packagePath: edgeClientPackagePath,
    bundlePath: edgeClientBundlePath,
  }],
])

const edgeExcludedPackages = new Set([
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-client-ui-cordis',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-reference',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-session-log-export',
])
const shellStaticPackages = new Set(['@deepseek-ai/dsh-client-ui-primitives'])
const assetSecurityHeaders = `/*
  Content-Security-Policy: frame-ancestors 'none'
  X-Frame-Options: DENY
`

function shortHash(input) {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function removeSourceMaps(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await removeSourceMaps(path)
    } else if (entry.name.endsWith('.map')) {
      await rm(path)
    }
  }
}

function deploymentPackageNames(patch) {
  const names = []
  for (const match of patch.matchAll(/^\s+name:\s+'([^']+)'\s*$/gm)) {
    if (!edgeExcludedPackages.has(match[1])) names.push(match[1])
  }
  return names
}

function clientBundleRelativePath(pkg) {
  const client = pkg.exports?.['./client']
  if (typeof client === 'string') return client
  if (client !== null && typeof client === 'object' && typeof client.default === 'string') {
    return client.default
  }
  throw new Error(`${pkg.name} is in the Web roster but exports no ./client bundle.`)
}

function resolvePublishedPackage(name) {
  for (const resolver of packageResolvers) {
    try {
      const packagePath = resolver.resolve(`${name}/package.json`)
      return { packagePath, bundlePath: undefined }
    } catch (error) {
      // Cordis manifests may name an exported package subpath. It has no
      // package-level client declaration of its own, so it is not a roster row.
      if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        throw error
      }
    }
  }
  return undefined
}

function injectOwnerSessionGuard(html) {
  const script = `<script>(() => {
  const originalFetch = window.fetch.bind(window)
  let redirecting = false
  window.fetch = async (...args) => {
    const input = args[0]
    const href = input instanceof Request ? input.url : String(input)
    const target = new URL(href, window.location.href)
    const response = await originalFetch(...args)
    if (!redirecting
      && response.status === 401
      && response.headers.get('www-authenticate') === 'DshEdgeOwner'
      && target.origin === window.location.origin
      && target.pathname.startsWith('/api/')) {
      redirecting = true
      window.location.replace('/login')
    }
    return response
  }
})()</script>`
  const head = html.indexOf('<head>')
  return head === -1
    ? `${script}${html}`
    : `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
}

async function copyBundle(record, pkg, entries) {
  const declaration = pkg.dsh?.client
  if (declaration?.platform !== 'web') {
    throw new Error(`${pkg.name} is in the upstream Web roster but has no web dsh.client declaration.`)
  }
  const source = record.bundlePath
    ?? resolve(dirname(record.packagePath), clientBundleRelativePath(pkg))
  const contents = await readFile(source)
  const rev = shortHash(contents)
  const destination = join(outputRoot, 'plugins', pkg.name, 'client.js')
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, contents)

  entries.push({
    id: pkg.name,
    url: `/plugins/${pkg.name}/client.js?rev=${rev}`,
    rev,
    ...(Array.isArray(declaration.inject) ? { inject: declaration.inject } : {}),
    ...(declaration.immediately === true ? { immediately: true } : {}),
    ...(Array.isArray(declaration.external) && declaration.external.length > 0
      ? { external: declaration.external }
      : {}),
  })
}

async function main() {
  if (!await isDirectory(shellDist)) {
    throw new Error('@deepseek-ai/dsh-web-frontend does not contain its published dist directory.')
  }

  const declared = []
  for (const patchPath of deploymentPatches) {
    declared.push(...deploymentPackageNames(await readFile(patchPath, 'utf8')))
  }
  declared.push(...edgeClientPackages.keys())

  const roster = []
  const records = new Map()
  for (const name of declared) {
    if (records.has(name)) continue
    const record = edgeClientPackages.get(name) ?? resolvePublishedPackage(name)
    if (record === undefined) continue
    const pkg = JSON.parse(await readFile(record.packagePath, 'utf8'))
    if (pkg.dsh?.client?.platform !== 'web') continue
    records.set(name, { ...record, pkg })
    roster.push(name)
  }

  await rm(outputRoot, { recursive: true, force: true })
  await cp(shellDist, outputRoot, { recursive: true })
  await removeSourceMaps(outputRoot)

  const entries = []
  for (const name of roster) {
    const record = records.get(name)
    await copyBundle(record, record.pkg, entries)
  }

  const selected = new Set(entries.map(entry => entry.id))
  for (const entry of entries) {
    for (const dependency of entry.inject ?? []) {
      if (!selected.has(dependency) && !shellStaticPackages.has(dependency)) {
        throw new Error(`${entry.id} injects missing Edge Web package ${dependency}.`)
      }
    }
  }

  const orderedEntries = orderByModuleGraph(entries)
  const bootstrapIds = new Set(['@deepseek-ai/dsh-client-modules'])
  const bootstrapEntries = orderedEntries.filter(e => bootstrapIds.has(e.id))
  const applicationEntries = orderedEntries.filter(e => !bootstrapIds.has(e.id))
  const batches = []
  if (bootstrapEntries.length > 0) {
    batches.push({
      phase: 'bootstrap',
      url: bootstrapEntries[0].url,
      rev: bootstrapEntries[0].rev,
      entries: bootstrapEntries.map(e => ({ id: e.id, url: e.url })),
    })
  }
  if (applicationEntries.length > 0) {
    const appRev = shortHash(JSON.stringify(applicationEntries.map(e => e.id)))
    batches.push({
      phase: 'application',
      url: applicationEntries[0].url,
      rev: appRev,
      entries: applicationEntries.map(e => ({ id: e.id, url: e.url })),
    })
  }
  const graph = { rev: shortHash(JSON.stringify(orderedEntries)), entries: orderedEntries, batches }
  const indexPath = join(outputRoot, 'index.html')
  const index = await readFile(indexPath, 'utf8')
  const bootstrappedIndex = renderIndexInjections(index, bootInjections(graph))
  await writeFile(indexPath, injectOwnerSessionGuard(bootstrappedIndex))
  await writeFile(join(outputRoot, '_headers'), assetSecurityHeaders)
  console.log(
    `Assembled ${entries.length} published upstream client plugins in ${relative(repoRoot, outputRoot)} (rev ${graph.rev}).`,
  )
}

await main()
