import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, win32 } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { compareVersions, validate } from 'compare-versions'
import edgePackage from '../package.json' with { type: 'json' }

const TRANSIENT_CODES = ['E409', 'E429', 'E500', 'E502', 'E503', 'E504', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']
const PUBLISH_ATTEMPTS = 4
const RETRY_BASE_MS = 2_000

export function targetTag(version) {
  return version.includes('-') ? 'next' : 'latest'
}

export function publishTag(version, current) {
  return current === undefined || compareVersions(version, current) > 0 ? targetTag(version) : 'historical'
}

export function resolveNpmInvocation(args, environment = process.env, runtime = {
  platform: process.platform,
  nodeExecutable: process.execPath,
  pathExists: existsSync,
}) {
  if (runtime.platform !== 'win32') return { command: 'npm', args }
  const searchPath = Object.entries(environment).find(([name]) => name.toUpperCase() === 'PATH')?.[1]
  if (searchPath === undefined) throw new Error('npm PATH is unavailable')
  for (const rawDirectory of searchPath.split(win32.delimiter)) {
    const directory = rawDirectory.startsWith('"') && rawDirectory.endsWith('"')
      ? rawDirectory.slice(1, -1)
      : rawDirectory
    const shim = win32.join(directory, 'npm.cmd')
    const cli = win32.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (runtime.pathExists(shim) && runtime.pathExists(cli)) {
      return { command: runtime.nodeExecutable, args: [cli, ...args] }
    }
  }
  throw new Error('npm.cmd with an adjacent npm-cli.js was not found on PATH')
}

function npm(args, echo = false) {
  const invocation = resolveNpmInvocation(args)
  const result = spawnSync(invocation.command, [...invocation.args], {
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  if (echo) {
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function registryIntegrity(name, version) {
  const result = npm(['view', `${name}@${version}`, 'dist.integrity', '--json'])
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`
    if (output.includes('E404') || output.includes('404 Not Found')) return undefined
    throw new Error(`npm view failed:\n${output}`)
  }
  const parsed = JSON.parse(result.stdout)
  if (typeof parsed !== 'string' || parsed === '') throw new Error('registry returned invalid dist.integrity')
  return parsed
}

function registryTags(name) {
  const result = npm(['view', name, 'dist-tags', '--json'])
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`
    if (output.includes('E404') || output.includes('404 Not Found')) return {}
    throw new Error(`npm view failed:\n${output}`)
  }
  const parsed = JSON.parse(result.stdout)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('registry returned invalid dist-tags')
  }
  return parsed
}

export function readPackedIdentity(tarball) {
  const result = npm(['pack', tarball, '--dry-run', '--json', '--ignore-scripts', '--loglevel=error'])
  if (result.status !== 0) {
    throw new Error(`npm could not inspect the tarball:\n${result.stdout}${result.stderr}`)
  }
  const packed = JSON.parse(result.stdout)
  const manifest = Array.isArray(packed) && packed.length === 1 ? packed[0] : undefined
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('npm returned invalid packed metadata')
  }
  if (manifest.name !== edgePackage.name) {
    throw new Error(`tarball contains ${String(manifest.name)} instead of ${edgePackage.name}`)
  }
  if (typeof manifest.version !== 'string' || !validate(manifest.version)) {
    throw new Error('tarball contains an invalid package version')
  }
  if (manifest.id !== `${manifest.name}@${manifest.version}`) {
    throw new Error('npm returned inconsistent packed identity')
  }
  return { name: manifest.name, version: manifest.version }
}

export function assertReleaseIdentity(identity) {
  if (identity.version !== edgePackage.version) {
    throw new Error(`tarball contains ${identity.name}@${identity.version}, but the checkout expects ${edgePackage.name}@${edgePackage.version}`)
  }
  return identity
}

async function publish(tarball) {
  const identity = assertReleaseIdentity(readPackedIdentity(tarball))
  const localIntegrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
  const existing = registryIntegrity(identity.name, identity.version)
  if (existing !== undefined) {
    if (existing !== localIntegrity) throw new Error(`${identity.name}@${identity.version} already has different content`)
    console.log(`${identity.name}@${identity.version} is already published with the same integrity`)
    return
  }

  const desiredTag = targetTag(identity.version)
  const tag = publishTag(identity.version, registryTags(identity.name)[desiredTag])
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
    const result = npm(['publish', tarball, '--tag', tag, '--ignore-scripts'], true)
    if (result.status === 0) return
    if (registryIntegrity(identity.name, identity.version) === localIntegrity) return
    const output = `${result.stdout}${result.stderr}`
    if (attempt === PUBLISH_ATTEMPTS || !TRANSIENT_CODES.some(code => output.includes(`code ${code}`))) {
      throw new Error(`npm publish failed:\n${output}`)
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
  }
}

const invoked = process.argv[1] === fileURLToPath(import.meta.url)
if (invoked) {
  const { values } = parseArgs({ options: { tarball: { type: 'string' } } })
  if (values.tarball === undefined) throw new Error('Usage: publish.mjs --tarball <path>')
  await publish(resolve(values.tarball))
}
