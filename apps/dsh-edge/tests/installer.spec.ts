import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type {
  CommandResult,
  InstallRecovery,
  InstallerUi,
  RuntimeMode,
} from '../scripts/install.mjs'
import {
  accountChoices,
  attachmentBucketName,
  createOutputForwarder,
  createTerminalSanitizer,
  inspectExistingDeployment,
  executeWrangler,
  ensureR2Bucket,
  generateOwnerSecret,
  installEdge,
  InstallerOutputError,
  parseClaimUrl,
  parseDeploymentOutput,
  parseWhoami,
  parseWorkerExistence,
  processGroupExists,
  resolveOwnerSecret,
  resolveWranglerClose,
  truncateUtf8Tail,
  unauthenticatedEnvironment,
  validateOwnerSecret,
  validateWorkerName,
  wranglerEnvironment,
  wranglerDeployArgs,
  wranglerProcessInvocation,
} from '../scripts/install.mjs'
import { parseWranglerGzipBytes, requireGzipBudget } from '../scripts/bundle-size.mjs'
import {
  renderPrebuiltModeWranglerConfig,
  containerImageReference,
  renderSourceModeWranglerConfig,
  workerArtifactPath,
} from '../scripts/wrangler-config.mjs'

import edgePackage from '../package.json' with { type: 'json' }

const EDGE_VERSION = edgePackage.version
const ACCOUNT = { id: 'account-1', name: 'Personal' }
const OWNER_SECRET = 'owner-access-key-with-at-least-32-bytes'
// Supplies the new instance's owner key so recovery assertions can name it.
const OWNER_ENV = { DSH_EDGE_ACCESS_KEY: OWNER_SECRET }

interface RunOptions {
  environment?: NodeJS.ProcessEnv
  interactive?: boolean
  forwardOutput?: boolean
  capture?: boolean
  signal?: AbortSignal
}

function parseJsonRecord(source: string): Record<string, unknown> {
  const value = JSON.parse(source) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object.')
  }
  return value as Record<string, unknown>
}

async function expectPrivateTemporaryFile(path: string): Promise<void> {
  const metadata = await stat(path)
  expect(metadata.isFile()).toBe(true)
  // Windows exposes synthetic POSIX mode bits rather than NTFS ACLs. The
  // production directory path establishes and verifies a user-only DACL
  // before this callback, and the integration assertion verifies cleanup.
  if (process.platform !== 'win32') {
    expect(metadata.mode & 0o777).toBe(0o600)
  }
}

describe('Wrangler process group probe', () => {
  it.skipIf(process.platform === 'win32')('counts an exited but unreaped group as existing, then gone once reaped', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' })
    const exited = new Promise(resolve => child.once('exit', resolve))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(processGroupExists(child.pid!)).toBe(true)
    process.kill(-child.pid!, 'SIGKILL')
    // Without yielding, Node cannot reap the child: macOS then answers EPERM for the group.
    const until = Date.now() + 200
    while (Date.now() < until) { /* hold the event loop */ }
    expect(processGroupExists(child.pid!)).toBe(true)
    await exited
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(processGroupExists(child.pid!)).toBe(false)
  })
})

describe('dsh-edge installer primitives', () => {
  it('puts signed-in accounts before a temporary account, which only installs offer', () => {
    expect(accountChoices([ACCOUNT]).map(choice => choice.value)).toEqual([
      'account:account-1',
      'temporary',
      'login',
    ])
    expect(accountChoices([]).map(choice => choice.value)).toEqual(['temporary', 'login'])
    expect(accountChoices([ACCOUNT], 'upgrade').map(choice => choice.value)).toEqual([
      'account:account-1',
      'login',
    ])
  })

  it('parses only authenticated, well-formed Wrangler account output', () => {
    expect(parseWhoami(JSON.stringify({
      loggedIn: true,
      email: 'owner@example.com',
      accounts: [ACCOUNT],
    }))).toEqual({ accounts: [ACCOUNT], email: 'owner@example.com' })
    expect(() => parseWhoami('{"loggedIn":false}')).toThrow('authenticated')
    expect(() => parseWhoami('not json')).toThrow('invalid account information')
    expect(() => parseWhoami(JSON.stringify({
      loggedIn: true,
      accounts: [{ id: 'account-1', name: '\u001B[31mspoofed' }],
    }))).toThrow('malformed Cloudflare account information')
    expect(() => parseWhoami(JSON.stringify({
      loggedIn: true,
      accounts: [{ id: 'account-1\nspoofed', name: 'Personal' }],
    }))).toThrow('malformed Cloudflare account information')
    expect(() => parseWhoami(JSON.stringify({
      loggedIn: true,
      accounts: [{ id: 'account-1', name: '\u009B31mspoofed' }],
    }))).toThrow('malformed Cloudflare account information')
    expect(() => parseWhoami(JSON.stringify({
      loggedIn: true,
      accounts: [{ id: 'account-1', name: '\u202Espoofed' }],
    }))).toThrow('malformed Cloudflare account information')
    expect(() => parseWhoami(JSON.stringify({
      loggedIn: true,
      email: 'owner\u2066@example.com',
      accounts: [ACCOUNT],
    }))).toThrow('malformed Cloudflare account information')
  })

  it.each([
    ['dsh-edge', undefined],
    ['a', undefined],
    ['a'.repeat(63), undefined],
    ['-edge', 'Use 1–63'],
    ['edge-', 'Use 1–63'],
    ['Edge', 'Use 1–63'],
    ['a'.repeat(64), 'Use 1–63'],
  ])('validates Worker name %s', (value, message) => {
    if (message === undefined) expect(validateWorkerName(value)).toBeUndefined()
    else expect(validateWorkerName(value)).toContain(message)
  })

  it('derives stable R2 bucket names within Cloudflare limits', () => {
    expect(attachmentBucketName('dsh-edge')).toBe('dsh-edge-attachments')
    const long = attachmentBucketName('a'.repeat(63))
    expect(long).toMatch(/^a{42}-[a-f0-9]{8}-attachments$/u)
    expect(long).toHaveLength(63)
  })

  it('reuses or creates the exact private R2 bucket', async () => {
    const existing = vi.fn(async () => commandResult(
      0,
      JSON.stringify({ name: 'dsh-edge-attachments' }),
    ))
    await expect(ensureR2Bucket({
      bucketName: 'dsh-edge-attachments',
      runWrangler: existing,
      environment: { CLOUDFLARE_ACCOUNT_ID: 'account-1' },
    })).resolves.toEqual({ bucketName: 'dsh-edge-attachments', created: false })
    expect(existing).toHaveBeenCalledOnce()

    const creating = vi.fn()
      .mockResolvedValueOnce(commandResult(1, '', 'not found'))
      .mockResolvedValueOnce(commandResult(0))
    await expect(ensureR2Bucket({
      bucketName: 'dsh-edge-attachments',
      runWrangler: creating,
      profile: 'dsh-edge-install',
    })).resolves.toEqual({ bucketName: 'dsh-edge-attachments', created: true })
    expect(creating.mock.calls[1]?.[0]).toEqual([
      'r2', 'bucket', 'create', 'dsh-edge-attachments', '--profile', 'dsh-edge-install',
    ])
  })

  it('fails with an actionable R2 recovery path and never deletes a bucket', async () => {
    const unavailable = vi.fn(async (_args: string[]) => commandResult(1, '', [
      '(node:26776) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.',
      '(Use `node --trace-deprecation ...` to show where the warning was created)',
      'Please enable R2 through the Cloudflare Dashboard. [code: 10042]',
    ].join('\n')))

    const pending = ensureR2Bucket({
      bucketName: 'dsh-edge-attachments',
      runWrangler: unavailable,
    })
    await expect(pending).rejects.toThrow(/R2 is not enabled.*10042/u)
    await expect(pending).rejects.not.toThrow(/punycode|trace-deprecation/u)
    expect(unavailable).toHaveBeenCalledOnce()
    expect(unavailable.mock.calls.flatMap(call => call[0])).not.toContain('delete')
  })

  it('generates and validates login secrets without weakening the runtime contract', () => {
    const generated = generateOwnerSecret()
    expect(new TextEncoder().encode(generated).byteLength).toBeGreaterThanOrEqual(32)
    expect(validateOwnerSecret(generated)).toBeUndefined()
    expect(validateOwnerSecret('short')).toContain('32–512')
    expect(validateOwnerSecret(` ${OWNER_SECRET}`)).toContain('whitespace')
    expect(validateOwnerSecret(`${OWNER_SECRET}\n`)).toContain('whitespace')
    expect(validateOwnerSecret(`${OWNER_SECRET}\u202E`)).toContain('bidirectional')
  })

  it('takes a new owner key from DSH_EDGE_ACCESS_KEY or generates one', () => {
    expect(resolveOwnerSecret({ DSH_EDGE_ACCESS_KEY: OWNER_SECRET })).toBe(OWNER_SECRET)
    expect(validateOwnerSecret(resolveOwnerSecret({}))).toBeUndefined()
    expect(validateOwnerSecret(resolveOwnerSecret({ DSH_EDGE_ACCESS_KEY: '' }))).toBeUndefined()
    expect(() => resolveOwnerSecret({ DSH_EDGE_ACCESS_KEY: 'short' }))
      .toThrow('DSH_EDGE_ACCESS_KEY is invalid: The access key must be 32\u2013512 UTF-8 bytes.')
  })

  it('passes only runtime and selected Cloudflare inputs to Wrangler', () => {
    const result = wranglerEnvironment({
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_CONFIG_PATH: '/cloudflare/config',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      GITHUB_TOKEN: 'github-secret',
      OTHER_SECRET: 'other-secret',
      PATH: '/bin',
      HOME: '/owner',
      LC_TEST: 'locale',
      LC_SECRET: 'locale-secret',
      NODE_OPTIONS: '--require malicious.cjs',
      Path: 'C:\\Windows\\System32',
    })
    expect(result).toEqual({
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_CONFIG_PATH: '/cloudflare/config',
      PATH: '/bin',
      HOME: '/owner',
      LC_TEST: 'locale',
      Path: 'C:\\Windows\\System32',
    })
  })

  it('strips every authentication source from temporary Wrangler commands', () => {
    const result = unauthenticatedEnvironment({
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_API_KEY: 'key',
      CLOUDFLARE_EMAIL: 'email',
      CF_ACCOUNT_ID: 'legacy-account',
      CF_API_TOKEN: 'legacy-token',
      CF_API_KEY: 'legacy-key',
      CF_EMAIL: 'legacy-email',
      CLOUDFLARE_CONFIG_PATH: '/authenticated/config',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      GITHUB_TOKEN: 'github-secret',
      OTHER_SECRET: 'other-secret',
      NODE_OPTIONS: '--require malicious.cjs',
      PATH: '/bin',
    })
    expect(result).toEqual({ PATH: '/bin' })
  })

  it('builds secret-free commands for both runtime modes', () => {
    expect(wranglerDeployArgs({
      mode: 'direct',
      workerName: 'dsh-edge',
      secretsFile: '/private/secrets.json',
      configFile: '/private/wrangler.json',
      temporary: true,
    })).toEqual([
      'deploy', '--env', '', '--name', 'dsh-edge', '--config',
      '/private/wrangler.json', '--tag', `v${EDGE_VERSION}`, '--secrets-file', '/private/secrets.json', '--temporary',
    ])
    expect(wranglerDeployArgs({
      mode: 'isolated',
      workerName: 'private-edge',
      secretsFile: '/private/secrets.json',
      configFile: '/private/wrangler.json',
      profile: 'dsh-edge-install',
    })).toContain('isolated')
    // An update passes no secrets file, so the Worker keeps its secrets.
    expect(wranglerDeployArgs({
      mode: 'container',
      workerName: 'private-edge',
      configFile: '/private/wrangler.json',
    })).toEqual([
      'deploy', '--env', 'container', '--name', 'private-edge', '--config', '/private/wrangler.json',
      '--tag', `v${EDGE_VERSION}`,
    ])
    expect(() => wranglerDeployArgs({
      mode: 'isolated',
      workerName: 'private-edge',
      secretsFile: '/private/secrets.json',
      configFile: '/private/wrangler.json',
      temporary: true,
    })).toThrow('only the Free direct runtime')
  })

  it('renders the Container environment on the isolated artifact with the published image', () => {
    const root = resolve('fixture', 'dsh-edge')
    const source = `{
      "name": "dsh-edge",
      "main": "src/index.ts",
      "assets": { "directory": "./dist" },
      "env": {
        "isolated": { "worker_loaders": [{ "binding": "LOADER" }] },
        "container": {
          "worker_loaders": [{ "binding": "LOADER" }],
          "vars": { "DSH_EDGE_CONTAINER_RUNTIME": "enabled" },
          "containers": [{ "class_name": "DshEdgeInstance", "image": "./container/Dockerfile" }],
        },
      },
    }`
    const container = parseJsonRecord(renderPrebuiltModeWranglerConfig('container', source, {
      appDirectory: root,
      r2BucketName: 'dsh-edge-attachments',
      enableImages: true,
    }))
    // An installed package never builds: it deploys this release's public image.
    expect(container).toMatchObject({
      main: resolve(root, 'worker/isolated/index.js'),
      no_bundle: true,
      env: { container: {
        vars: {
          DSH_EDGE_CONTAINER_RUNTIME: 'enabled',
          DSH_EDGE_ATTACHMENT_STORAGE: 'private-r2',
        },
        r2_buckets: [{ binding: 'DSH_EDGE_ATTACHMENTS', bucket_name: 'dsh-edge-attachments' }],
        images: { binding: 'IMAGES' },
        containers: [{
          class_name: 'DshEdgeInstance',
          name: 'dsh-edge-container',
          image: containerImageReference(),
        }],
      } },
    })
    // Cloudflare names the application from the config, so each Worker renders its own.
    const named = parseJsonRecord(renderPrebuiltModeWranglerConfig('container', source, {
      appDirectory: root, workerName: 'team-edge',
    }))
    expect(named).toMatchObject({
      name: 'team-edge',
      env: { container: { containers: [{ name: 'team-edge-container' }] } },
    })
    expect(containerImageReference()).toBe(`docker.io/pawaca/dsh-edge-computer:${EDGE_VERSION}`)
    expect(containerImageReference('1.2.3-alpha.1')).toBe('docker.io/pawaca/dsh-edge-computer:1.2.3-alpha.1')
    expect(() => containerImageReference('latest')).toThrow(/Invalid release version/u)
    expect(workerArtifactPath('container', { appDirectory: root }))
      .toBe(resolve(root, 'worker/isolated/index.js'))

    const local = parseJsonRecord(renderPrebuiltModeWranglerConfig('container', source, {
      appDirectory: root,
      localContainerImage: true,
    }))
    expect(local).toMatchObject({ env: { container: {
      containers: [{ image: resolve(root, 'container/Dockerfile') }],
    } } })

    const pinned = parseJsonRecord(renderPrebuiltModeWranglerConfig('container', source, {
      appDirectory: root,
      containerImage: 'docker.io/example/computer:1@sha256:abc',
    }))
    expect(pinned).toMatchObject({ env: { container: {
      containers: [{ image: 'docker.io/example/computer:1@sha256:abc' }],
    } } })

    expect(() => renderPrebuiltModeWranglerConfig('container', source, {
      appDirectory: root, containerImage: './elsewhere/Dockerfile',
    })).toThrow(/registry reference/u)
    expect(() => renderPrebuiltModeWranglerConfig('container', source, {
      appDirectory: root, localContainerImage: true, containerImage: 'docker.io/example/computer:1',
    })).toThrow(/not both/u)
    expect(() => renderSourceModeWranglerConfig('container' as never, source, { appDirectory: root }))
      .toThrow(/Unsupported runtime mode/u)
    expect(() => renderPrebuiltModeWranglerConfig('container', source.replace(/"containers": \[.*\],/u, ''), {
      appDirectory: root,
    })).toThrow(/containers/u)
  })

  it('renders mode-specific Wrangler configs from one repository source', () => {
    const root = resolve('fixture', 'dsh-edge')
    const source = `{
      // The checked-in source remains valid JSONC.
      "$schema": "node_modules/wrangler/config-schema.json",
      "main": "src/index.ts",
      "assets": { "directory": "./dist" },
      "env": { "isolated": { "worker_loaders": [{ "binding": "LOADER" }] } },
    }`
    const direct = parseJsonRecord(renderSourceModeWranglerConfig('direct', source, {
      appDirectory: root,
    }))
    const isolated = parseJsonRecord(renderSourceModeWranglerConfig('isolated', source, {
      appDirectory: root,
    }))
    const prebuiltDirect = parseJsonRecord(renderPrebuiltModeWranglerConfig(
      'direct',
      source,
      { appDirectory: root, r2BucketName: 'dsh-edge-attachments' },
    ))
    const prebuiltIsolated = parseJsonRecord(renderPrebuiltModeWranglerConfig(
      'isolated',
      source,
      { appDirectory: root, r2BucketName: 'dsh-edge-attachments' },
    ))

    expect(direct).toMatchObject({
      main: resolve(root, 'src/index.ts'),
      assets: { directory: resolve(root, 'dist') },
      vars: { DSH_EDGE_ATTACHMENT_STORAGE: 'temporary-do' },
      minify: true,
      alias: {
        '@cloudflare/computer/shell/core': resolve(root, 'src/direct-shell-core-empty.ts'),
      },
    })
    expect(direct).not.toHaveProperty('$schema')
    expect(isolated).toMatchObject({
      main: resolve(root, 'src/index.ts'),
      assets: { directory: resolve(root, 'dist') },
      minify: true,
      env: { isolated: {
        vars: { DSH_EDGE_ATTACHMENT_STORAGE: 'temporary-do' },
        worker_loaders: [{ binding: 'LOADER' }],
      } },
      alias: {
        './direct-shell.ts': resolve(root, 'src/isolated-direct-shell-unavailable.ts'),
      },
    })
    expect(prebuiltDirect).toMatchObject({
      main: resolve(root, 'worker/direct/index.js'),
      assets: { directory: resolve(root, 'dist') },
      no_bundle: true,
      find_additional_modules: false,
      vars: { DSH_EDGE_ATTACHMENT_STORAGE: 'private-r2' },
      r2_buckets: [{
        binding: 'DSH_EDGE_ATTACHMENTS',
        bucket_name: 'dsh-edge-attachments',
      }],
    })
    expect(prebuiltDirect).not.toHaveProperty('alias')
    expect(prebuiltDirect).not.toHaveProperty('minify')
    expect(prebuiltIsolated).toMatchObject({
      main: resolve(root, 'worker/isolated/index.js'),
      env: { isolated: {
        vars: { DSH_EDGE_ATTACHMENT_STORAGE: 'private-r2' },
        worker_loaders: [{ binding: 'LOADER' }],
        r2_buckets: [{
          binding: 'DSH_EDGE_ATTACHMENTS',
          bucket_name: 'dsh-edge-attachments',
        }],
      } },
      no_bundle: true,
    })

    const imagesDirectConfig = parseJsonRecord(renderPrebuiltModeWranglerConfig(
      'direct', source, { appDirectory: root, enableImages: true },
    ))
    expect(imagesDirectConfig).toHaveProperty('images', { binding: 'IMAGES' })

    const imagesIsolatedConfig = parseJsonRecord(renderPrebuiltModeWranglerConfig(
      'isolated', source, { appDirectory: root, enableImages: true },
    ))
    expect((imagesIsolatedConfig.env as Record<string, unknown>)?.isolated).toHaveProperty('images', { binding: 'IMAGES' })

    const noImagesConfig = parseJsonRecord(renderPrebuiltModeWranglerConfig(
      'direct', source, { appDirectory: root },
    ))
    expect(noImagesConfig).not.toHaveProperty('images')

    const standalone = parseJsonRecord(renderSourceModeWranglerConfig('direct', source, {
      appDirectory: root,
      assetsDirectory: '/standalone/dist',
      aliases: {
        '@deepseek-ai/dsh-agent': '/standalone/node_modules/@deepseek-ai/dsh-agent',
      },
    }))
    expect(standalone).toMatchObject({
      assets: { directory: '/standalone/dist' },
      alias: {
        '@deepseek-ai/dsh-agent': '/standalone/node_modules/@deepseek-ai/dsh-agent',
        '@cloudflare/computer/shell/core': resolve(root, 'src/direct-shell-core-empty.ts'),
      },
    })
  })

  it('rejects an invalid or pre-aliased Wrangler source', () => {
    expect(() => renderSourceModeWranglerConfig('direct', '{', { appDirectory: '/app' }))
      .toThrow('Could not parse wrangler.jsonc')
    expect(() => renderSourceModeWranglerConfig('direct', JSON.stringify({
      main: 'src/index.ts',
      assets: { directory: 'dist' },
      alias: { '@cloudflare/computer/shell/core': './unexpected.ts' },
    }), { appDirectory: '/app' })).toThrow('reserves')
    expect(() => renderSourceModeWranglerConfig('isolated', JSON.stringify({
      main: 'src/index.ts',
      assets: { directory: 'dist' },
      alias: { './direct-shell.ts': './unexpected.ts' },
    }), { appDirectory: '/app' })).toThrow('reserves')
    expect(() => renderSourceModeWranglerConfig('direct', JSON.stringify({
      main: 'src/index.ts',
      assets: { directory: 'dist' },
    }), {
      appDirectory: '/app',
      aliases: { '@cloudflare/computer/shell/core': '/unexpected.ts' },
    })).toThrow('reserve')
    expect(() => renderSourceModeWranglerConfig('direct', JSON.stringify({
      main: 'src/index.ts',
      assets: { directory: 'dist' },
    }), { appDirectory: '/app', assetsDirectory: '' })).toThrow('non-empty')
  })

  it('enforces the direct Worker compressed-size budget', () => {
    const output = 'Total Upload: 2148.37 KiB / gzip: 592.39 KiB'
    expect(parseWranglerGzipBytes(output)).toBe(Math.ceil(592.39 * 1024))
    expect(requireGzipBudget(output, 900 * 1024)).toBe(Math.ceil(592.39 * 1024))
    expect(() => requireGzipBudget(
      'Total Upload: 3913.70 KiB / gzip: 1004.80 KiB',
      900 * 1024,
    )).toThrow('exceeds')
  })

  it('parses structured deployment metadata and the temporary claim URL', () => {
    expect(parseDeploymentOutput([
      JSON.stringify({ type: 'other', version: 1 }),
      JSON.stringify({
        type: 'deploy',
        version: 1,
        version_id: 'version-1',
        targets: ['dsh-edge.owner.workers.dev'],
      }),
    ].join('\n'))).toEqual({
      publicUrl: 'https://dsh-edge.owner.workers.dev',
      versionId: 'version-1',
    })
    expect(parseClaimUrl(
      '\u001b[32mClaim URL: https://dash.cloudflare.com/claim-preview?token=secret\u001b[0m',
    )).toBe('https://dash.cloudflare.com/claim-preview?token=secret')
    expect(parseClaimUrl(
      'Claim URL: https://dash.cloudflare.com/claim-preview?token=secret\u009B31mspoofed',
    )).toBeUndefined()
    expect(parseClaimUrl(
      'Claim URL: https://dash.cloudflare.com/claim-preview?token=secret\u202Espoofed',
    )).toBeUndefined()
    expect(() => parseDeploymentOutput('{"type":"deploy","version":1,"targets":[]}'))
      .toThrow('public workers.dev URL')
  })

  it.each([
    'https://example.com',
    'https://dsh-edge.owner.workers.dev.example.com',
    'https://workers.dev',
    'https://evilworkers.dev',
    'https://dsh-edge.owner.workers.dev/workspace',
  ])('rejects a non-workers.dev handoff target: %s', (target) => {
    expect(() => parseDeploymentOutput(JSON.stringify({
      type: 'deploy',
      version: 1,
      targets: [target],
    }))).toThrow('public workers.dev URL')
  })

  it('treats only Cloudflare error 10007 as a missing Worker', () => {
    expect(parseWorkerExistence(commandResult(0, '[]'))).toBe(true)
    expect(parseWorkerExistence(commandResult(1, '', 'Worker missing [code: 10007]'))).toBe(false)
    expect(() => parseWorkerExistence(commandResult(1, '', 'network failed')))
      .toThrow('network failed')
  })

  it('reads an existing Worker\'s mode from the bindings its runtime providers probe', async () => {
    const storage = { name: 'DSH_EDGE_ATTACHMENT_STORAGE', type: 'plain_text', text: 'temporary-do' }
    const loader = { name: 'LOADER', type: 'worker_loader' }
    const container = { name: 'DSH_EDGE_CONTAINER_RUNTIME', type: 'plain_text', text: 'enabled' }
    const versions: Record<string, unknown[]> = {}
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'deployments') {
        return commandResult(0, JSON.stringify({ versions: Object.keys(versions).map(version_id => ({ version_id, percentage: 50 })) }))
      }
      return commandResult(0, JSON.stringify({ resources: { bindings: [INSTANCE_BINDING, ...versions[args[2]!]!] } }))
    })
    const inspect = () => inspectExistingDeployment({ workerName: 'dsh-edge', runWrangler, profile: 'owner' })

    for (const [bindings, mode] of [
      [[storage], 'direct'],
      [[storage, loader], 'isolated'],
      [[storage, loader, container], 'container'],
    ] as const) {
      versions['version-a'] = [...bindings]
      await expect(inspect()).resolves.toEqual({ mode, attachmentStorage: 'temporary-do', sessionFormatUpgrade: true })
    }
    // `--name` selects the Worker whatever mode deployed it, so no `--env` is needed.
    expect(runWrangler.mock.calls.map(call => call[0])).toContainEqual([
      'deployments', 'status', '--name', 'dsh-edge', '--json', '--profile', 'owner',
    ])
    versions['version-b'] = [storage]
    await expect(inspect()).rejects.toThrow(/run different capabilities/u)
  })

  it('detects one consistent attachment backend across active Worker versions', async () => {
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'deployments') {
        return commandResult(0, JSON.stringify({
          versions: [
            { version_id: 'version-a', percentage: 50 },
            { version_id: 'version-b', percentage: 50 },
          ],
        }))
      }
      return commandResult(0, JSON.stringify({
        resources: { bindings: [INSTANCE_BINDING, {
          name: 'DSH_EDGE_ATTACHMENT_STORAGE',
          type: 'plain_text',
          text: 'temporary-do',
        }] },
      }))
    })

    await expect(inspectExistingDeployment({
      workerName: 'dsh-edge',
      runWrangler,
    })).resolves.toMatchObject({ attachmentStorage: 'temporary-do' })
    expect(runWrangler).toHaveBeenCalledTimes(3)
  })

  it('gives unmarked pre-attachment versions the new-install image storage', async () => {
    const runWrangler = vi.fn()
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({
        versions: [{ version_id: 'legacy-version', percentage: 100 }],
      })))
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({
        resources: { bindings: [INSTANCE_BINDING] },
      })))

    await expect(inspectExistingDeployment({
      workerName: 'dsh-edge',
      runWrangler,
    })).resolves.toEqual({ mode: 'direct', attachmentStorage: 'temporary-do', sessionFormatUpgrade: true })
  })

  it('flags a session-format upgrade unless every active version carries a 0.19+ release tag', async () => {
    const tags: Record<string, string | undefined> = {}
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'deployments') {
        return commandResult(0, JSON.stringify({ versions: Object.keys(tags).map(version_id => ({ version_id, percentage: 50 })) }))
      }
      const tag = tags[args[2]!]
      return commandResult(0, JSON.stringify({
        resources: { bindings: [INSTANCE_BINDING] },
        ...tag === undefined ? {} : { annotations: { 'workers/tag': tag } },
      }))
    })
    const upgrade = async () => (await inspectExistingDeployment({ workerName: 'dsh-edge', runWrangler }))?.sessionFormatUpgrade
    tags['version-a'] = 'v0.19.0-alpha.1'
    expect(await upgrade()).toBe(false)
    tags['version-a'] = 'v1.0.0'
    expect(await upgrade()).toBe(false)
    // A gradual rollout still serving an untagged (0.18) version keeps the note.
    tags['version-b'] = undefined
    expect(await upgrade()).toBe(true)
    delete tags['version-b']
    tags['version-a'] = 'v0.18.0'
    expect(await upgrade()).toBe(true)
  })

  it('recognizes an unmarked R2 binding as authoritative', async () => {
    const runWrangler = vi.fn()
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({
        versions: [{ version_id: 'r2-version', percentage: 100 }],
      })))
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({
        resources: { bindings: [INSTANCE_BINDING, { name: 'DSH_EDGE_ATTACHMENTS', type: 'r2_bucket' }] },
      })))

    await expect(inspectExistingDeployment({
      workerName: 'dsh-edge',
      runWrangler,
    })).resolves.toMatchObject({ attachmentStorage: 'private-r2' })
  })

  it('refuses an ambiguous rollout or malformed attachment binding', async () => {
    const status = commandResult(0, JSON.stringify({
      versions: [
        { version_id: 'version-do', percentage: 50 },
        { version_id: 'version-r2', percentage: 50 },
      ],
    }))
    const runWrangler = vi.fn()
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({
        resources: { bindings: [INSTANCE_BINDING, {
          name: 'DSH_EDGE_ATTACHMENT_STORAGE',
          type: 'plain_text',
          text: 'temporary-do',
        }] },
      })))
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({
        resources: { bindings: [INSTANCE_BINDING, { name: 'DSH_EDGE_ATTACHMENTS', type: 'r2_bucket' }] },
      })))

    await expect(inspectExistingDeployment({
      workerName: 'dsh-edge',
      runWrangler,
    })).rejects.toThrow(/different attachment backends/u)
  })

  it('launches Wrangler through Node instead of a platform-specific shim', () => {
    expect(wranglerProcessInvocation(['deploy'], {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      wranglerCli: 'C:\\repo\\wrangler\\cli.js',
    })).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\repo\\wrangler\\cli.js', 'deploy'],
    })
  })

  it('bounds captured diagnostics by UTF-8 bytes without splitting characters', () => {
    expect(truncateUtf8Tail('prefix你好🙂', 8)).toBe('好🙂')
    expect(truncateUtf8Tail('prefix你好🙂', 6)).toBe('🙂')

    const retained = truncateUtf8Tail('界'.repeat(800_000), 2 * 1024 * 1024)
    expect(new TextEncoder().encode(retained).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(retained).not.toContain('\uFFFD')
  })

  it('pauses interactive output until a slow destination drains', () => {
    const pause = vi.fn()
    const resume = vi.fn()
    const source = { pause, resume } as unknown as NodeJS.ReadableStream
    const destination = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValue(false),
    }) as unknown as NodeJS.WritableStream
    const forwarder = createOutputForwarder(source, destination, vi.fn())

    forwarder.write('diagnostic')

    expect(pause).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
    destination.emit('drain')
    expect(resume).toHaveBeenCalledOnce()
    forwarder.dispose()
  })

  it('keeps a flowing child stream active when output is accepted', () => {
    const pause = vi.fn()
    const source = { pause, resume: vi.fn() } as unknown as NodeJS.ReadableStream
    const destination = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValue(true),
    }) as unknown as NodeJS.WritableStream
    const forwarder = createOutputForwarder(source, destination, vi.fn())

    forwarder.write('diagnostic')

    expect(pause).not.toHaveBeenCalled()
    forwarder.dispose()
  })

  it('settles a pending output write when forwarding is cancelled', async () => {
    const source = { pause: vi.fn(), resume: vi.fn() } as unknown as NodeJS.ReadableStream
    const destination = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValue(false),
    }) as unknown as NodeJS.WritableStream
    const forwarder = createOutputForwarder(source, destination, vi.fn())

    forwarder.write('diagnostic')
    const settled = forwarder.settled()
    forwarder.cancel()

    await expect(settled).resolves.toBeUndefined()
    forwarder.dispose()
  })

  it('filters interactive terminal controls across output chunks', () => {
    const sanitizer = createTerminalSanitizer()

    expect(sanitizer.push('plain\u001B[3')).toBe('plain')
    expect(sanitizer.push('1mred\u001B[2Jafter\u001B]0;spo')).toBe('redafter')
    expect(sanitizer.push('of\u0007tail\u009B31mC1\u0000\tline\n')).toBe('tailC1\tline\n')
    expect(sanitizer.push('before\u001B[8mhidden\u001B[0mafter')).toBe('beforehiddenafter')
    expect(sanitizer.push('a\u061Cb\u200Ec\u200Fd\u202Ae\u202Ef\u2066g\u2069h')).toBe('abcdefgh')
  })

  it('preserves a successful child exit that races with interruption', () => {
    const controller = new AbortController()
    const interrupted = new Error('interrupted by SIGINT')
    const processError = new Error('The operation was aborted')
    processError.name = 'AbortError'
    controller.abort(interrupted)

    expect(resolveWranglerClose({
      processError,
      signal: controller.signal,
      status: 0,
      stderr: '',
      stdout: 'uploaded',
    })).toEqual({ interrupted: true, status: 0, stderr: '', stdout: 'uploaded' })
    expect(() => resolveWranglerClose({
      processError,
      signal: controller.signal,
      status: null,
      stderr: '',
      stdout: '',
    })).toThrow(interrupted)
  })

  it('preserves a successful child exit that races with an output failure', () => {
    const outputFailure = new InstallerOutputError('stdout', new Error('broken pipe'))

    expect(resolveWranglerClose({
      outputFailure,
      status: 0,
      stderr: '',
      stdout: 'uploaded',
    })).toEqual({ outputFailure, status: 0, stderr: '', stdout: 'uploaded' })
    const controller = new AbortController()
    controller.abort(new Error('interrupted'))
    expect(resolveWranglerClose({
      outputFailure,
      signal: controller.signal,
      status: 0,
      stderr: '',
      stdout: 'uploaded',
    })).toEqual({
      interrupted: true,
      outputFailure,
      status: 0,
      stderr: '',
      stdout: 'uploaded',
    })
    expect(() => resolveWranglerClose({
      outputFailure,
      status: null,
      stderr: '',
      stdout: '',
    })).toThrow(outputFailure)
  })

  it.runIf(process.platform !== 'win32')(
    'terminates and joins the Wrangler process group before resolving an interruption',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-process-tree-test-'))
      const helperPidFile = join(directory, 'helper.pid')
      const controller = new AbortController()
      const interrupted = new Error('interrupted by SIGINT')
      let helperPid = 0
      const helperScript = [
        "import { writeFileSync } from 'node:fs'",
        'writeFileSync(process.argv[1], String(process.pid))',
        "process.on('SIGTERM', () => {})",
        'setInterval(() => {}, 1_000)',
      ].join(';')
      const parentScript = [
        "import { spawn } from 'node:child_process'",
        `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(helperScript)}, process.argv[1]], { stdio: 'ignore' })`,
        "process.on('SIGTERM', () => process.exit(0))",
        'setInterval(() => {}, 1_000)',
      ].join(';')

      try {
        const execution = executeWrangler([], {
          environment: {},
          forceKillAfterDelay: 500,
          invocation: {
            command: process.execPath,
            args: ['--input-type=module', '-e', parentScript, helperPidFile],
          },
          signal: controller.signal,
        })
        helperPid = Number(await readEventually(helperPidFile))
        controller.abort(interrupted)

        await expect(execution).resolves.toMatchObject({ interrupted: true, status: 0 })
        await expectProcessGone(helperPid)
      } finally {
        if (helperPid > 0) {
          try {
            process.kill(helperPid, 'SIGKILL')
          } catch {
            // The managed tree already reaped the helper.
          }
        }
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it('routes an interactive output failure through managed Wrangler termination', async () => {
    const brokenOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
      },
    })

    await expect(executeWrangler([], {
      capture: false,
      environment: {},
      forceKillAfterDelay: 100,
      interactive: true,
      invocation: {
        command: process.execPath,
        args: [
          '--input-type=module',
          '-e',
          "process.stdout.write('diagnostic'); setInterval(() => {}, 1_000)",
        ],
      },
      stdoutDestination: brokenOutput,
    })).rejects.toThrow('Could not write installer stdout: broken pipe')
  })

})

describe('dsh-edge guided installation', () => {
  it('installs a temporary direct Worker, isolates auth, and removes secrets', async () => {
    const {
      activationFinish,
      activationStart,
      confirm,
      selectCapability,
      ui,
      success,
    } = createUi({ accountSelections: ['temporary'] })
    let secretsPath = ''
    let configPath = ''
    let deployEnvironment: NodeJS.ProcessEnv | undefined
    const runWrangler = vi.fn(async (
      args: string[],
      options: RunOptions = {},
    ): Promise<CommandResult> => {
      if (args[0] === 'whoami') return commandResult(0, '{"loggedIn":false}')
      expect(args).toContain('--temporary')
      expect(args).not.toContain(OWNER_SECRET)
      secretsPath = args[args.indexOf('--secrets-file') + 1] ?? ''
      configPath = args[args.indexOf('--config') + 1] ?? ''
      deployEnvironment = options.environment
      await expectPrivateTemporaryFile(secretsPath)
      await expectPrivateTemporaryFile(configPath)
      const config = parseJsonRecord(await readFile(configPath, 'utf8'))
      expect(config).toMatchObject({
        no_bundle: true,
        find_additional_modules: false,
      })
      if (typeof config.main !== 'string') throw new TypeError('Expected a string entrypoint.')
      expect(config.main.endsWith(join('worker', 'direct', 'index.js'))).toBe(true)
      expect(config).not.toHaveProperty('alias')
      expect(config).not.toHaveProperty('minify')
      // A temporary account has no Images binding; the DeepSeek key is added later in Settings.
      expect(config).not.toHaveProperty('images')
      expect(JSON.parse(await readFile(secretsPath, 'utf8'))).toEqual({
        DSH_EDGE_ACCESS_KEY: OWNER_SECRET,
      })
      await writeFile(options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '', JSON.stringify({
        type: 'deploy',
        version: 1,
        version_id: 'version-1',
        targets: ['dsh-edge.preview.workers.dev'],
      }))
      return commandResult(
        0,
        'Claim URL: https://dash.cloudflare.com/claim-preview?token=claim-secret',
      )
    })
    const observeActivation = vi.fn().mockResolvedValue({ attempts: 4, elapsedMs: 4_500, status: 'ready' })
    const result = await installEdge({
      ui,
      runWrangler,
      observeActivation,
      environment: {
        CLOUDFLARE_API_TOKEN: 'must-not-leak',
        PATH: '/bin',
        ...OWNER_ENV,
      },
    })

    expect(result).toMatchObject({
      publicUrl: 'https://dsh-edge.preview.workers.dev',
      claimUrl: 'https://dash.cloudflare.com/claim-preview?token=claim-secret',
      mode: 'direct',
      temporary: true,
      updated: false,
      activation: { attempts: 4, elapsedMs: 4_500, status: 'ready' },
    })
    // A temporary account runs only the free capabilities, so nothing asks for them.
    expect(selectCapability).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ temporary: true, updating: false }))
    expect(observeActivation).toHaveBeenCalledWith(expect.objectContaining({ versionId: 'version-1' }))
    expect(deployEnvironment?.CLOUDFLARE_API_TOKEN).toBeUndefined()
    expect(deployEnvironment?.DSH_EDGE_ACCESS_KEY).toBeUndefined()
    expect(deployEnvironment?.XDG_CONFIG_HOME).toBe(dirname(secretsPath))
    await expect(stat(secretsPath)).rejects.toThrow()
    await expect(stat(configPath)).rejects.toThrow()
    await expect(stat(dirname(secretsPath))).rejects.toThrow()
    expect(activationStart).toHaveBeenCalledWith(
      'Activating the public URL… Cloudflare usually takes 10–30 seconds.',
    )
    expect(activationFinish).toHaveBeenCalledWith({
      attempts: 4,
      elapsedMs: 4_500,
      status: 'ready',
    })
    expect(success).toHaveBeenCalledOnce()
  }, 45_000)

  it('reports a successful upload when public activation remains pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { activationFinish, recovery, success, ui } = createUi()
    const result = await installEdge({
      ui,
      runWrangler: successfulRunWrangler(),
      createTemporaryDirectory: async () => directory,
      observeActivation: vi.fn().mockResolvedValue({
        attempts: 12,
        elapsedMs: 45_000,
        status: 'pending',
      }),
    })

    expect(result.activation).toEqual({
      attempts: 12,
      elapsedMs: 45_000,
      status: 'pending',
    })
    expect(activationFinish).toHaveBeenCalledWith(result.activation)
    expect(recovery).not.toHaveBeenCalled()
    expect(success).toHaveBeenCalledWith(result)
  })

  it('preserves recovery details when activation waiting is interrupted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { activationFinish, recovery, success, ui } = createUi()
    const interrupted = new Error('interrupted while waiting')

    await expect(installEdge({
      ui,
      runWrangler: successfulRunWrangler(),
      environment: OWNER_ENV,
      createTemporaryDirectory: async () => directory,
      observeActivation: vi.fn().mockRejectedValue(interrupted),
    })).rejects.toBe(interrupted)

    expect(activationFinish).toHaveBeenCalledWith()
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      ownerSecret: OWNER_SECRET,
      publicUrl: 'https://dsh-edge.owner.workers.dev',
    }))
    expect(success).not.toHaveBeenCalled()
    await expect(stat(directory)).rejects.toThrow()
  })

  it('reports recovery instead of success when final cleanup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui, cleanupFailure, recovery, success } = createUi()
    const cleanupError = new Error('directory is locked')
    const removePath: typeof rm = async (path, options) => {
      if (path === directory) throw cleanupError
      await rm(path, options)
    }

    try {
      await expect(installEdge({
        ui,
        runWrangler: successfulRunWrangler(),
        environment: OWNER_ENV,
        removePath,
        createTemporaryDirectory: async () => directory,
      })).rejects.toThrow('Could not remove private temporary files: directory is locked')

      expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
        ownerSecret: OWNER_SECRET,
        publicUrl: 'https://dsh-edge.owner.workers.dev',
      }))
      expect(cleanupFailure).not.toHaveBeenCalled()
      expect(success).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves a primary failure when final cleanup also fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui, cleanupFailure, success } = createUi()
    const primaryError = new Error('upload transport failed')
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'whoami') {
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
      throw primaryError
    })
    const removePath: typeof rm = async (path, options) => {
      if (path === directory) throw new Error('directory is locked')
      await rm(path, options)
    }

    try {
      await expect(installEdge({
        ui,
        runWrangler,
        removePath,
        createTemporaryDirectory: async () => directory,
      })).rejects.toBe(primaryError)

      expect(cleanupFailure).toHaveBeenCalledWith(
        'Could not remove private temporary files: directory is locked',
      )
      expect(success).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves interruption identity and exit semantics when final cleanup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui, cleanupFailure, success } = createUi()
    const controller = new AbortController()
    const interrupted = new Error('interrupted by SIGTERM')
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'whoami') {
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
      controller.abort(interrupted)
      throw interrupted
    })
    const removePath: typeof rm = async (path, options) => {
      if (path === directory) throw new Error('directory is locked')
      await rm(path, options)
    }

    try {
      await expect(installEdge({
        ui,
        runWrangler,
        removePath,
        signal: controller.signal,
        createTemporaryDirectory: async () => directory,
      })).rejects.toBe(interrupted)

      expect(cleanupFailure).toHaveBeenCalledWith(
        'Could not remove private temporary files: directory is locked',
      )
      expect(success).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rechecks interruption after awaited final cleanup before reporting success', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui, cleanupFailure, recovery, success } = createUi()
    const controller = new AbortController()
    const interrupted = new Error('interrupted by SIGINT')
    const removePath: typeof rm = async (path, options) => {
      await rm(path, options)
      if (path === directory) controller.abort(interrupted)
    }

    await expect(installEdge({
      ui,
      runWrangler: successfulRunWrangler(),
      environment: OWNER_ENV,
      removePath,
      signal: controller.signal,
      createTemporaryDirectory: async () => directory,
    })).rejects.toBe(interrupted)

    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      ownerSecret: OWNER_SECRET,
      publicUrl: 'https://dsh-edge.owner.workers.dev',
    }))
    expect(cleanupFailure).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
  })

  it('signs in, asks what the agent should do, and installs it after one confirmation', async () => {
    const rawProfileDir = await mkdtemp(join(tmpdir(), 'dsh-edge-profile-test-'))
    const canonicalProfileDir = await realpath(rawProfileDir)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const dirs = [rawProfileDir, directory]
    let dirIndex = 0
    const { ui, confirm, existingWorker, selectAccount, selectCapability, workerName } = createUi({
      capabilities: ['isolated'],
      accountSelections: ['login', 'account:account-1'],
    })
    const calls: string[][] = []
    let deployedConfig: unknown
    let secrets: unknown
    const runWrangler = vi.fn(async (
      args: string[],
      options: RunOptions = {},
    ): Promise<CommandResult> => {
      calls.push(args)
      if (args[0] === 'whoami' && !args.includes('--cwd')) {
        return commandResult(0, '{"loggedIn":false}')
      }
      if (args[0] === 'auth') {
        expect(options.environment?.CLOUDFLARE_API_TOKEN).toBeUndefined()
        return commandResult(0)
      }
      if (args[0] === 'whoami') {
        expect(args).toContain('--cwd')
        expect(args).toContain(canonicalProfileDir)
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
      expect(args).toContain('isolated')
      expect(args).toContain('dsh-edge-install')
      expect(options.environment?.CLOUDFLARE_ACCOUNT_ID).toBe('account-1')
      expect(options.environment?.CLOUDFLARE_API_TOKEN).toBeUndefined()
      expect(options.forwardOutput).toBe(false)
      deployedConfig = await readDeployedConfig(args)
      secrets = JSON.parse(await readFile(args[args.indexOf('--secrets-file') + 1]!, 'utf8'))
      await writeFile(options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '', JSON.stringify({
        type: 'deploy', version: 1, targets: ['dsh-edge.owner.workers.dev'],
      }))
      return commandResult(0)
    })
    const result = await installEdge({
      ui,
      runWrangler,
      environment: { CLOUDFLARE_API_TOKEN: 'must-not-override-profile' },
      createTemporaryDirectory: async () => dirs[dirIndex++] ?? directory,
    })

    expect(selectAccount).toHaveBeenNthCalledWith(
      2,
      expect.not.arrayContaining([expect.objectContaining({ value: 'temporary' })]),
    )
    expect(calls).toContainEqual(['auth', 'create', 'dsh-edge-install'])
    expect(calls).toContainEqual(['auth', 'activate', 'dsh-edge-install', canonicalProfileDir])
    expect(calls).toContainEqual(['auth', 'deactivate', canonicalProfileDir])
    expect(calls).toContainEqual([
      'deployments', 'list', '--name', 'dsh-edge', '--json', '--profile', 'dsh-edge-install',
    ])
    // Account, name, capabilities, then the one confirmation; nothing after it.
    expect(existingWorker).not.toHaveBeenCalled()
    expect(workerName.mock.invocationCallOrder[0]).toBeLessThan(selectCapability.mock.invocationCallOrder[0]!)
    expect(selectCapability).toHaveBeenCalledWith()
    expect(confirm).toHaveBeenCalledWith({
      mode: 'isolated',
      accountLabel: 'Personal',
      workerName: 'dsh-edge',
      temporary: false,
      updating: false,
      attachmentStorage: 'temporary-do',
    })
    // Images stay in the instance without R2 setup; only the generated owner key is a secret.
    expect(calls.some(args => args[0] === 'r2')).toBe(false)
    expect(deployedConfig).not.toHaveProperty('env.isolated.r2_buckets')
    expect(deployedConfig).toHaveProperty('env.isolated.images', { binding: 'IMAGES' })
    expect(secrets).toEqual({ DSH_EDGE_ACCESS_KEY: result.ownerSecret })
    expect(validateOwnerSecret(result.ownerSecret!)).toBeUndefined()
  })

  it('rejects a status-0 output failure from interactive authentication', async () => {
    const { ui, selectAccount } = createUi({ accountSelections: ['login'] })
    const outputFailure = new InstallerOutputError('stdout', new Error('broken pipe'))
    const runWrangler = vi.fn()
      .mockResolvedValueOnce(commandResult(0, '{"loggedIn":false}'))
      .mockResolvedValueOnce({ ...commandResult(0), outputFailure })

    await expect(installEdge({ ui, runWrangler })).rejects.toBe(outputFailure)
    expect(runWrangler).toHaveBeenCalledTimes(2)
    expect(selectAccount).toHaveBeenCalledOnce()
  })

  it('does not silently overwrite an existing Worker', async () => {
    const { ui, existingWorker } = createUi({ existingActions: ['cancel'] })
    const runWrangler = existingWorkerWrangler([])

    await expect(installEdge({ ui, runWrangler })).rejects.toThrow('cancelled')
    expect(existingWorker).toHaveBeenCalledWith({ workerName: 'dsh-edge', mode: 'direct', sessionFormatUpgrade: true })
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(false)
  })

  it('never updates a Worker that is not dsh-edge', async () => {
    const foreign = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'whoami') return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      if (args[0] === 'deployments' && args[1] === 'list') return commandResult(0, '[{"id":"deployment"}]')
      if (args[0] === 'deployments') {
        return commandResult(0, JSON.stringify({ versions: [{ version_id: 'version-1', percentage: 100 }] }))
      }
      if (args[0] === 'versions') {
        return commandResult(0, JSON.stringify({ resources: { bindings: [{ name: 'API', type: 'kv_namespace' }] } }))
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    })
    const { ui, existingWorker, nameTaken } = createUi({ nameTakenActions: ['cancel'] })
    await expect(installEdge({ ui, runWrangler: foreign })).rejects.toThrow('cancelled')
    expect(nameTaken).toHaveBeenCalledWith('dsh-edge')
    expect(existingWorker).not.toHaveBeenCalled()
    await expect(installEdge({ command: 'upgrade', ui: createUi().ui, runWrangler: foreign }))
      .rejects.toThrow('dsh-edge is not a dsh-edge Worker.')
    expect(foreign.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(false)
  })

  it.each(['install', 'upgrade'] as const)(
    '%s updates an existing Worker in place, keeping its capabilities and secrets',
    async (command) => {
      const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-update-test-'))
      const { ui, confirm, existingWorker, selectAccount, selectCapability, success } = createUi()
      let deployArgs: string[] = []
      const runWrangler = existingWorkerWrangler([
        { name: 'DSH_EDGE_ATTACHMENT_STORAGE', type: 'plain_text', text: 'temporary-do' },
        { name: 'LOADER', type: 'worker_loader' },
      ], async (args) => {
        deployArgs = args
      })
      const observeActivation = vi.fn().mockResolvedValue({ attempts: 1, elapsedMs: 0, status: 'live' })

      const result = await installEdge({
        command, ui, runWrangler, observeActivation,
        environment: OWNER_ENV,
        createTemporaryDirectory: async () => directory,
      })

      expect(selectAccount).toHaveBeenCalledWith(command === 'upgrade'
        ? expect.not.arrayContaining([expect.objectContaining({ value: 'temporary' })])
        : expect.arrayContaining([expect.objectContaining({ value: 'temporary' })]))
      expect(existingWorker).toHaveBeenCalledWith({ workerName: 'dsh-edge', mode: 'isolated', sessionFormatUpgrade: true })
      // "Update it" is the confirmation: no capability question, summary, or key prompt.
      expect(selectCapability).not.toHaveBeenCalled()
      expect(confirm).not.toHaveBeenCalled()
      expect(deployArgs).toContain('isolated')
      expect(deployArgs).not.toContain('--secrets-file')
      expect(observeActivation).toHaveBeenCalledWith(expect.objectContaining({ ownerSecret: undefined }))
      expect(result).toMatchObject({
        attachmentStorage: 'temporary-do',
        mode: 'isolated',
        temporary: false,
        updated: true,
        workerName: 'dsh-edge',
      })
      expect(result.ownerSecret).toBeUndefined()
      expect(success).toHaveBeenCalledOnce()
    },
  )

  it('asks for the Worker name again, unchanged, when the owner wants another name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-rename-test-'))
    const { ui, confirm, existingWorker, workerName } = createUi({
      existingActions: ['rename'],
      workerNames: ['dsh-edge', 'dsh-edge-work'],
    })
    const runWrangler = existingWorkerWrangler([], undefined, args => (
      args[0] === 'deployments' && args[1] === 'list' && args.includes('dsh-edge-work')
        ? commandResult(1, '', '[code: 10007]')
        : undefined
    ))

    const result = await installEdge({
      ui, runWrangler, environment: OWNER_ENV, createTemporaryDirectory: async () => directory,
    })

    expect(existingWorker).toHaveBeenCalledOnce()
    expect(workerName.mock.calls).toEqual([
      ['dsh-edge', expect.any(Function)],
      ['dsh-edge', expect.any(Function)],
    ])
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ workerName: 'dsh-edge-work', updating: false }))
    expect(result).toMatchObject({ workerName: 'dsh-edge-work', updated: false })
  })

  it('changes an existing Worker\'s capabilities only after confirming what a downgrade removes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-change-test-'))
    const { ui, confirm, confirmDowngrade, selectCapability } = createUi({
      existingActions: ['change'],
      capabilities: ['direct', 'isolated'],
      downgradeAnswers: [false, true],
    })
    let deployArgs: string[] = []
    const runWrangler = existingWorkerWrangler([
      { name: 'DSH_EDGE_ATTACHMENT_STORAGE', type: 'plain_text', text: 'temporary-do' },
      { name: 'LOADER', type: 'worker_loader' },
      { name: 'DSH_EDGE_CONTAINER_RUNTIME', type: 'plain_text', text: 'enabled' },
    ], async (args) => {
      deployArgs = args
    })

    const result = await installEdge({
      ui, runWrangler, environment: OWNER_ENV, createTemporaryDirectory: async () => directory,
    })

    expect(selectCapability).toHaveBeenNthCalledWith(1, 'container')
    expect(confirmDowngrade).toHaveBeenNthCalledWith(1, [
      'analyze data and split big jobs',
      'work on code projects',
    ])
    // Declining the downgrade returns to the capability list.
    expect(confirmDowngrade).toHaveBeenNthCalledWith(2, ['work on code projects'])
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ mode: 'isolated', updating: true }))
    expect(deployArgs).toContain('isolated')
    expect(deployArgs).not.toContain('--secrets-file')
    expect(result).toMatchObject({ mode: 'isolated', updated: true })
  })

  it('keeps the Container application for rollback and prints a runnable removal command', async () => {
    const storage = { name: 'DSH_EDGE_ATTACHMENT_STORAGE', type: 'plain_text', text: 'temporary-do' }
    const loader = { name: 'LOADER', type: 'worker_loader' }
    const container = { name: 'DSH_EDGE_CONTAINER_RUNTIME', type: 'plain_text', text: 'enabled' }
    const id = 'a03efd01-3c6e-4609-bb6c-e07fb44e207c'
    for (const [previous, listing] of [
      ['container', commandResult(0, JSON.stringify([{ id, name: 'dsh-edge-container' }, { id: 'b03efd01-3c6e-4609-bb6c-e07fb44e207c', name: 'other-container' }]))],
      ['container', commandResult(1, '', 'Unauthorized')],
      ['isolated', undefined],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), `dsh-edge-leave-container-${previous}-`))
      const { ui, cleanupFailure } = createUi({ existingActions: ['change'], capabilities: ['direct'] })
      const runWrangler = existingWorkerWrangler(
        previous === 'container' ? [storage, loader, container] : [storage, loader],
        undefined,
        args => args[0] === 'containers' ? listing : undefined,
      )
      await installEdge({
        command: 'upgrade', ui, runWrangler, createTemporaryDirectory: async () => directory,
        observeActivation: async () => ({ status: 'live', attempts: 1, elapsedMs: 0 }),
      })
      // Only a read-only listing: the application is never deleted automatically.
      const containerCalls = runWrangler.mock.calls.map(call => call[0]).filter(args => args[0] === 'containers')
      if (previous === 'isolated') {
        expect(containerCalls).toEqual([])
        expect(cleanupFailure).not.toHaveBeenCalled()
      } else {
        expect(containerCalls).toEqual([['containers', 'list', '--json']])
        expect(cleanupFailure).toHaveBeenCalledWith(expect.stringMatching(listing.status === 0
          ? new RegExp(`kept for rollback.*: npx wrangler containers delete ${id}$`, 'su')
          : /kept for rollback.*containers list, then npx wrangler containers delete <id> for dsh-edge-container$/su))
      }
    }
  })

  it.each([
    ['an unmarked pre-attachment', []],
    ['a claimed temporary', [{ name: 'DSH_EDGE_ATTACHMENT_STORAGE', type: 'plain_text', text: 'temporary-do' }]],
  ])('updates %s Worker onto Durable Object image storage without R2', async (_label, bindings) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-update-do-test-'))
    const { ui } = createUi()
    let deployedConfig: unknown
    const runWrangler = existingWorkerWrangler(bindings, async (args) => {
      deployedConfig = await readDeployedConfig(args)
    })

    const result = await installEdge({
      command: 'upgrade',
      ui,
      runWrangler,
      createTemporaryDirectory: async () => directory,
    })

    expect(result.attachmentStorage).toBe('temporary-do')
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'r2')).toBe(false)
    expect(deployedConfig).not.toHaveProperty('r2_buckets')
    expect(deployedConfig).toHaveProperty(
      'vars.DSH_EDGE_ATTACHMENT_STORAGE',
      'temporary-do',
    )
  })

  it('keeps an R2 Worker on its bucket and only retries while R2 is not enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-update-r2-test-'))
    const { ui, r2SubscriptionUnavailable } = createUi({ r2RecoveryActions: ['retry'] })
    let deployedConfig: unknown
    let r2Calls = 0
    const runWrangler = existingWorkerWrangler([
      { name: 'DSH_EDGE_ATTACHMENTS', type: 'r2_bucket' },
      { name: 'DSH_EDGE_ATTACHMENT_STORAGE', type: 'plain_text', text: 'private-r2' },
    ], async (args) => {
      deployedConfig = await readDeployedConfig(args)
    }, (args) => {
      if (args[0] !== 'r2') return undefined
      return ++r2Calls === 1
        ? commandResult(1, '', 'Enable R2 in the Dashboard. [code: 10042]')
        : existingR2Bucket(args)
    })

    const result = await installEdge({
      command: 'upgrade',
      ui,
      runWrangler,
      createTemporaryDirectory: async () => directory,
    })

    expect(r2SubscriptionUnavailable).toHaveBeenCalledOnce()
    expect(r2SubscriptionUnavailable).toHaveBeenCalledWith({
      activationUrl: 'https://dash.cloudflare.com/account-1/r2/overview',
    })
    expect(result.attachmentStorage).toBe('private-r2')
    expect(deployedConfig).toHaveProperty('r2_buckets', [
      expect.objectContaining({ bucket_name: 'dsh-edge-attachments' }),
    ])
  })

  it('refuses to upgrade a missing Worker before asking anything else', async () => {
    const { ui, confirm, selectCapability } = createUi()
    const runWrangler = vi.fn()
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] })))
      .mockResolvedValueOnce(commandResult(1, '', '[code: 10007]'))

    await expect(installEdge({ command: 'upgrade', ui, runWrangler }))
      .rejects.toThrow('Run dsh-edge install first')
    expect(selectCapability).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('does not create a temporary account without explicit terms acceptance', async () => {
    const { ui } = createUi({
      accountSelections: ['temporary'],
      confirmed: false,
    })
    const runWrangler = vi.fn()
      .mockResolvedValueOnce(commandResult(1, '{"loggedIn":false}'))

    await expect(installEdge({ ui, runWrangler })).rejects.toThrow('cancelled')
    expect(runWrangler).toHaveBeenCalledTimes(1)
  })

  it('removes temporary credentials after an interrupted deployment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui } = createUi({ accountSelections: ['temporary'] })
    const controller = new AbortController()
    const interrupted = new Error('interrupted by SIGINT')
    let secretsPath = ''
    const runWrangler = vi.fn(async (
      args: string[],
      options: RunOptions = {},
    ): Promise<CommandResult> => {
      if (args[0] === 'whoami') return commandResult(0, '{"loggedIn":false}')
      secretsPath = args[args.indexOf('--secrets-file') + 1] ?? ''
      expect(await readFile(secretsPath, 'utf8')).toContain(OWNER_SECRET)
      expect(options.signal).toBe(controller.signal)
      controller.abort(interrupted)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(await readFile(secretsPath, 'utf8')).toContain(OWNER_SECRET)
      throw options.signal?.reason
    })

    await expect(installEdge({
      ui,
      runWrangler,
      environment: OWNER_ENV,
      signal: controller.signal,
      createTemporaryDirectory: async () => directory,
    })).rejects.toBe(interrupted)
    await expect(stat(secretsPath)).rejects.toThrow()
    await expect(stat(directory)).rejects.toThrow()
  })

  it('removes temporary credentials after an interactive output failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui } = createUi({ accountSelections: ['temporary'] })
    const brokenOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
      },
    })
    let secretsPath = ''
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'whoami') return commandResult(0, '{"loggedIn":false}')
      secretsPath = args[args.indexOf('--secrets-file') + 1] ?? ''
      expect(await readFile(secretsPath, 'utf8')).toContain('DSH_EDGE_ACCESS_KEY')
      return await executeWrangler([], {
        capture: false,
        environment: {},
        forceKillAfterDelay: 100,
        interactive: true,
        invocation: {
          command: process.execPath,
          args: [
            '--input-type=module',
            '-e',
            "process.stdout.write('diagnostic'); setInterval(() => {}, 1_000)",
          ],
        },
        stdoutDestination: brokenOutput,
      })
    })

    await expect(installEdge({
      ui,
      runWrangler,
      createTemporaryDirectory: async () => directory,
    })).rejects.toThrow('Could not write installer stdout: broken pipe')
    await expect(stat(secretsPath)).rejects.toThrow()
    await expect(stat(directory)).rejects.toThrow()
  })

  it('reports the active key after a status-0 interactive output failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui, outputFailureRecovery } = createUi({ accountSelections: ['temporary'] })
    const outputFailure = new InstallerOutputError('stdout', new Error('broken pipe'))
    let secretsPath = ''
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'whoami') return commandResult(0, '{"loggedIn":false}')
      secretsPath = args[args.indexOf('--secrets-file') + 1] ?? ''
      return { ...commandResult(0, 'uploaded'), outputFailure }
    })

    await expect(installEdge({
      ui,
      runWrangler,
      environment: OWNER_ENV,
      createTemporaryDirectory: async () => directory,
    })).rejects.toBe(outputFailure)
    expect(outputFailureRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSecret: OWNER_SECRET, workerName: 'dsh-edge' }),
      'stdout',
    )
    await expect(stat(secretsPath)).rejects.toThrow()
    await expect(stat(directory)).rejects.toThrow()
  })

  it.each(['supplied', 'generated'] as const)(
    'reports the active %s owner key when post-upload parsing fails',
    async (source) => {
      const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
      const { ui, recovery, success } = createUi()
      const runWrangler = vi.fn(async (
        args: string[],
        options: RunOptions = {},
      ): Promise<CommandResult> => {
        if (args[0] === 'whoami') {
          return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
        }
        if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
        await writeFile(options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '', 'not-json')
        return commandResult(0)
      })

      await expect(installEdge({
        ui,
        runWrangler,
        environment: source === 'supplied' ? OWNER_ENV : {},
        createTemporaryDirectory: async () => directory,
      })).rejects.toThrow('malformed deployment metadata')

      expect(recovery).toHaveBeenCalledOnce()
      const details = recovery.mock.calls[0]?.[0] as InstallRecovery
      expect(details).toMatchObject({ workerName: 'dsh-edge' })
      if (source === 'supplied') expect(details.ownerSecret).toBe(OWNER_SECRET)
      else expect(validateOwnerSecret(details.ownerSecret!)).toBeUndefined()
      expect(success).not.toHaveBeenCalled()
      await expect(stat(directory)).rejects.toThrow()
    },
  )

  it('rejects oversized structured output without losing recovery access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui, recovery } = createUi()
    const runWrangler = vi.fn(async (
      args: string[],
      options: RunOptions = {},
    ): Promise<CommandResult> => {
      if (args[0] === 'whoami') {
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
      await writeFile(
        options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '',
        'x'.repeat(2 * 1024 * 1024 + 1),
      )
      return commandResult(0)
    })

    await expect(installEdge({
      ui,
      runWrangler,
      environment: OWNER_ENV,
      createTemporaryDirectory: async () => directory,
    })).rejects.toThrow('deployment metadata exceeded 2097152 UTF-8 bytes')

    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      ownerSecret: OWNER_SECRET,
      workerName: 'dsh-edge',
    }))
    await expect(stat(directory)).rejects.toThrow()
  })

  it('reports the active key when post-upload credential cleanup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui, recovery } = createUi()
    const runWrangler = vi.fn(async (
      args: string[],
      options: RunOptions = {},
    ): Promise<CommandResult> => {
      if (args[0] === 'whoami') {
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
      await writeFile(options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '', JSON.stringify({
        type: 'deploy', version: 1, targets: ['dsh-edge.owner.workers.dev'],
      }))
      return commandResult(0)
    })
    const removePath: typeof rm = async (path, options) => {
      if (String(path).endsWith('secrets.json')) throw new Error('file is locked')
      await rm(path, options)
    }

    await expect(installEdge({
      ui,
      runWrangler,
      environment: OWNER_ENV,
      removePath,
      createTemporaryDirectory: async () => directory,
    })).rejects.toThrow('Could not remove temporary credentials: file is locked')

    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      ownerSecret: OWNER_SECRET,
      workerName: 'dsh-edge',
    }))
    await expect(stat(directory)).rejects.toThrow()
  })

  it('reports the active key when a successful upload races with interruption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui, recovery } = createUi()
    const controller = new AbortController()
    const interrupted = new Error('interrupted by SIGINT')
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'whoami') {
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
      controller.abort(interrupted)
      return { ...commandResult(0, 'uploaded'), interrupted: true }
    })

    await expect(installEdge({
      ui,
      runWrangler,
      environment: OWNER_ENV,
      signal: controller.signal,
      createTemporaryDirectory: async () => directory,
    })).rejects.toBe(interrupted)

    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      ownerSecret: OWNER_SECRET,
      workerName: 'dsh-edge',
    }))
    await expect(stat(directory)).rejects.toThrow()
  })

  it('summarizes validation failures and preserves a temporary-account claim path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const {
      deploymentFinish,
      deploymentStart,
      failedDeployment,
      recovery,
      success,
      ui,
    } = createUi({ accountSelections: ['temporary'] })
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'whoami') return commandResult(0, '{"loggedIn":false}')
      return commandResult(
        1,
        'Claim URL: https://dash.cloudflare.com/claim-preview?token=claim-secret',
        'Worker validation failed [code: 10021]\nfull noisy diagnostic',
      )
    })

    await expect(installEdge({
      ui,
      runWrangler,
      createTemporaryDirectory: async () => directory,
    })).rejects.toThrow(
      'Cloudflare rejected the Worker module during validation (code 10021). '
      + 'Run the command again with --verbose to inspect Wrangler output.',
    )

    expect(deploymentStart).toHaveBeenCalledWith('Installing the tested Worker release…')
    expect(deploymentFinish).toHaveBeenCalledWith(false)
    expect(failedDeployment).toHaveBeenCalledWith({
      claimUrl: 'https://dash.cloudflare.com/claim-preview?token=claim-secret',
      workerName: 'dsh-edge',
    })
    expect(recovery).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
    await expect(stat(directory)).rejects.toThrow()
  })

  it('adds a Workers Paid recovery path to paid deployment failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui } = createUi({ capabilities: ['isolated'] })
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'whoami') {
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
      return commandResult(1, '', 'Worker Loader is unavailable')
    })

    await expect(installEdge({
      ui,
      runWrangler,
      createTemporaryDirectory: async () => directory,
    })).rejects.toThrow(/Workers Paid plan.*choose "Research and write"/su)
    await expect(stat(directory)).rejects.toThrow()
  })
})

function commandResult(status: number | null, stdout = '', stderr = ''): CommandResult {
  return { status, stdout, stderr }
}

function successfulRunWrangler(): (
  args: string[],
  options?: RunOptions,
) => Promise<CommandResult> {
  return vi.fn(async (
    args: string[],
    options: RunOptions = {},
  ): Promise<CommandResult> => {
    if (args[0] === 'whoami') {
      return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
    }
    if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
    await writeFile(options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '', JSON.stringify({
      type: 'deploy', version: 1, targets: ['dsh-edge.owner.workers.dev'],
    }))
    return commandResult(0)
  })
}

function existingR2Bucket(args: string[]): CommandResult | undefined {
  return args[0] === 'r2'
    ? commandResult(0, JSON.stringify({ name: 'dsh-edge-attachments' }))
    : undefined
}

async function readEventually(path: string): Promise<string> {
  const deadline = Date.now() + 2_000
  while (true) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (true) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() >= deadline) throw new Error(`process ${pid} is still alive`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Answer every prompt the way pressing Enter would, unless a test overrides it. */
function createUi({
  capabilities = ['direct'],
  accountSelections = ['account:account-1'],
  existingActions = ['update'],
  nameTakenActions = ['rename'],
  workerNames = [],
  confirmed = true,
  downgradeAnswers = [true],
  r2RecoveryActions = ['cancel'],
}: {
  capabilities?: RuntimeMode[]
  accountSelections?: string[]
  existingActions?: Array<'update' | 'change' | 'rename' | 'cancel'>
  nameTakenActions?: Array<'rename' | 'cancel'>
  workerNames?: string[]
  confirmed?: boolean
  downgradeAnswers?: boolean[]
  r2RecoveryActions?: Array<'retry' | 'cancel'>
} = {}): {
  ui: InstallerUi
  activationFinish: Mock
  activationStart: Mock
  cleanupFailure: Mock
  confirm: Mock
  confirmDowngrade: Mock
  deploymentFinish: Mock
  deploymentStart: Mock
  existingWorker: Mock
  nameTaken: Mock
  failedDeployment: Mock
  outputFailureRecovery: Mock
  recovery: Mock
  r2SubscriptionUnavailable: Mock
  selectAccount: Mock
  selectCapability: Mock
  success: Mock
  workerName: Mock
} {
  const selectAccount = vi.fn()
    .mockImplementation(async () => accountSelections.shift() ?? 'account:account-1')
  const workerName = vi.fn()
    .mockImplementation(async (initialValue: string) => workerNames.shift() ?? initialValue)
  const existingWorker = vi.fn().mockImplementation(async () => existingActions.shift() ?? 'update')
  const nameTaken = vi.fn().mockImplementation(async () => nameTakenActions.shift() ?? 'cancel')
  const selectCapability = vi.fn()
    .mockImplementation(async (current?: RuntimeMode) => capabilities.shift() ?? current ?? 'direct')
  const confirmDowngrade = vi.fn().mockImplementation(async () => downgradeAnswers.shift() ?? false)
  const r2SubscriptionUnavailable = vi.fn()
    .mockImplementation(async () => r2RecoveryActions.shift() ?? 'cancel')
  const success = vi.fn()
  const recovery = vi.fn()
  const outputFailureRecovery = vi.fn()
  const cleanupFailure = vi.fn()
  const confirm = vi.fn().mockResolvedValue(confirmed)
  const deploymentStart = vi.fn()
  const deploymentFinish = vi.fn()
  const activationStart = vi.fn()
  const activationFinish = vi.fn()
  const failedDeployment = vi.fn()
  const ui: InstallerUi = {
    intro: vi.fn(),
    step: vi.fn(),
    selectAccount,
    workerName,
    existingWorker,
    nameTaken,
    selectCapability,
    confirmDowngrade,
    r2SubscriptionUnavailable,
    confirm,
    cleanupFailure,
    deploymentStart,
    deploymentFinish,
    activationStart,
    activationFinish,
    failedDeployment,
    recovery,
    outputFailureRecovery,
    success,
  }
  return {
    ui,
    activationFinish,
    activationStart,
    cleanupFailure,
    confirm,
    confirmDowngrade,
    deploymentFinish,
    deploymentStart,
    existingWorker,
    nameTaken,
    failedDeployment,
    outputFailureRecovery,
    recovery,
    r2SubscriptionUnavailable,
    selectAccount,
    selectCapability,
    success,
    workerName,
  }
}

/** The Durable Object binding that identifies a dsh-edge Worker. */
const INSTANCE_BINDING = { name: 'DSH_EDGE_INSTANCE', type: 'durable_object_namespace' }

/** A signed-in account whose `dsh-edge` Worker already runs with `bindings`. */
function existingWorkerWrangler(
  bindings: unknown[],
  onDeploy: (args: string[], options: RunOptions) => Promise<void> = async () => {},
  handle: (args: string[]) => CommandResult | undefined = () => undefined,
): Mock<(args: string[], options?: RunOptions) => Promise<CommandResult>> {
  return vi.fn(async (args: string[], options: RunOptions = {}): Promise<CommandResult> => {
    const handled = handle(args)
    if (handled !== undefined) return handled
    if (args[0] === 'whoami') return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
    if (args[0] === 'deployments' && args[1] === 'list') return commandResult(0, '[{"id":"deployment"}]')
    if (args[0] === 'deployments' && args[1] === 'status') {
      return commandResult(0, JSON.stringify({ versions: [{ version_id: 'version-1', percentage: 100 }] }))
    }
    if (args[0] === 'versions') {
      return commandResult(0, JSON.stringify({ resources: { bindings: [INSTANCE_BINDING, ...bindings] } }))
    }
    if (args[0] !== 'deploy') throw new Error(`unexpected command: ${args.join(' ')}`)
    await onDeploy(args, options)
    await writeFile(options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '', JSON.stringify({
      type: 'deploy', version: 1, targets: ['dsh-edge.owner.workers.dev'],
    }))
    return commandResult(0)
  })
}

async function readDeployedConfig(args: string[]): Promise<unknown> {
  const configPath = args[args.indexOf('--config') + 1]
  if (configPath === undefined) throw new Error('deploy command omitted its config path')
  return JSON.parse(await readFile(configPath, 'utf8')) as unknown
}
