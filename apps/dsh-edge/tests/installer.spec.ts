import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  detectExistingAttachmentStorage,
  executeWrangler,
  ensureR2Bucket,
  generateOwnerSecret,
  installEdge,
  InstallerOutputError,
  parseClaimUrl,
  parseDeploymentOutput,
  parseWhoami,
  parseWorkerExistence,
  resolveWranglerClose,
  truncateUtf8Tail,
  unauthenticatedEnvironment,
  validateDeepSeekKey,
  validateOwnerSecret,
  validateWorkerName,
  wranglerEnvironment,
  wranglerDeployArgs,
  wranglerProcessInvocation,
} from '../scripts/install.mjs'
import { parseWranglerGzipBytes, requireGzipBudget } from '../scripts/bundle-size.mjs'
import {
  renderPrebuiltModeWranglerConfig,
  renderSourceModeWranglerConfig,
} from '../scripts/wrangler-config.mjs'

const ACCOUNT = { id: 'account-1', name: 'Personal' }
const OWNER_SECRET = 'owner-access-key-with-at-least-32-bytes'

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

describe('dsh-edge installer primitives', () => {
  it('offers temporary accounts only for the Free runtime', () => {
    expect(accountChoices('direct', [ACCOUNT]).map(choice => choice.value)).toEqual([
      'temporary',
      'account:account-1',
      'login',
    ])
    expect(accountChoices('isolated', [ACCOUNT]).map(choice => choice.value)).toEqual([
      'account:account-1',
      'login',
    ])
    expect(accountChoices('direct', [ACCOUNT], 'upgrade').map(choice => choice.value)).toEqual([
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
    const unavailable = vi.fn(async (_args: string[]) => (
      commandResult(1, '', 'R2 subscription is not enabled')
    ))

    await expect(ensureR2Bucket({
      bucketName: 'dsh-edge-attachments',
      runWrangler: unavailable,
    })).rejects.toThrow(/Enable R2.*temporary preview.*retry/u)
    expect(unavailable).toHaveBeenCalledTimes(3)
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
    expect(validateDeepSeekKey('sk-test')).toBeUndefined()
    expect(validateDeepSeekKey('')).toContain('Enter')
    expect(validateDeepSeekKey(' sk-test')).toContain('whitespace')
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
      '/private/wrangler.json', '--secrets-file', '/private/secrets.json', '--temporary',
    ])
    expect(wranglerDeployArgs({
      mode: 'isolated',
      workerName: 'private-edge',
      secretsFile: '/private/secrets.json',
      configFile: '/private/wrangler.json',
      profile: 'dsh-edge-install',
    })).toContain('isolated')
    expect(() => wranglerDeployArgs({
      mode: 'isolated',
      workerName: 'private-edge',
      secretsFile: '/private/secrets.json',
      configFile: '/private/wrangler.json',
      temporary: true,
    })).toThrow('only the Free direct runtime')
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
        resources: { bindings: [{
          name: 'DSH_EDGE_ATTACHMENT_STORAGE',
          type: 'plain_text',
          text: 'temporary-do',
        }] },
      }))
    })

    await expect(detectExistingAttachmentStorage({
      workerName: 'dsh-edge',
      mode: 'direct',
      runWrangler,
    })).resolves.toBe('temporary-do')
    expect(runWrangler).toHaveBeenCalledTimes(3)
  })

  it('initializes unmarked pre-attachment versions on private R2', async () => {
    const runWrangler = vi.fn()
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({
        versions: [{ version_id: 'legacy-version', percentage: 100 }],
      })))
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({
        resources: { bindings: [{ name: 'DSH_EDGE_INSTANCE', type: 'durable_object_namespace' }] },
      })))

    await expect(detectExistingAttachmentStorage({
      workerName: 'dsh-edge',
      mode: 'direct',
      runWrangler,
    })).resolves.toBe('private-r2')
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
        resources: { bindings: [{
          name: 'DSH_EDGE_ATTACHMENT_STORAGE',
          type: 'plain_text',
          text: 'temporary-do',
        }] },
      })))
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({
        resources: { bindings: [{ name: 'DSH_EDGE_ATTACHMENTS', type: 'r2_bucket' }] },
      })))

    await expect(detectExistingAttachmentStorage({
      workerName: 'dsh-edge',
      mode: 'direct',
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
      ui,
      success,
    } = createUi({ mode: 'direct', accountSelections: ['temporary'] })
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
      expect(args).not.toContain('sk-test')
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
      expect(JSON.parse(await readFile(secretsPath, 'utf8'))).toEqual({
        DEEPSEEK_API_KEY: 'sk-test',
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
    const result = await installEdge({
      ui,
      runWrangler,
      observeActivation: vi.fn().mockResolvedValue({
        attempts: 4,
        elapsedMs: 4_500,
        status: 'ready',
      }),
      environment: {
        CLOUDFLARE_API_TOKEN: 'must-not-leak',
        PATH: '/bin',
      },
    })

    expect(result).toMatchObject({
      publicUrl: 'https://dsh-edge.preview.workers.dev',
      claimUrl: 'https://dash.cloudflare.com/claim-preview?token=claim-secret',
      mode: 'direct',
      temporary: true,
      activation: { attempts: 4, elapsedMs: 4_500, status: 'ready' },
    })
    expect(deployEnvironment?.CLOUDFLARE_API_TOKEN).toBeUndefined()
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
      if (args[0] === 'r2') return existingR2Bucket(args)!
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
      if (args[0] === 'r2') return existingR2Bucket(args)!
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

  it('signs in, filters out temporary accounts, and installs the isolated runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui, selectAccount } = createUi({
      mode: 'isolated',
      accountSelections: ['login', 'account:account-1'],
    })
    const calls: string[][] = []
    const runWrangler = vi.fn(async (
      args: string[],
      options: RunOptions = {},
    ): Promise<CommandResult> => {
      calls.push(args)
      if (args[0] === 'whoami' && !args.includes('--profile')) {
        return commandResult(0, '{"loggedIn":false}')
      }
      if (args[0] === 'auth') {
        expect(options.environment?.CLOUDFLARE_API_TOKEN).toBeUndefined()
        return commandResult(0)
      }
      if (args[0] === 'whoami') {
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
      if (args[0] === 'r2') {
        expect(args).toContain('dsh-edge-install')
        expect(options.environment?.CLOUDFLARE_ACCOUNT_ID).toBe('account-1')
        return existingR2Bucket(args)!
      }
      expect(args).toContain('isolated')
      expect(args).toContain('dsh-edge-install')
      expect(options.environment?.CLOUDFLARE_ACCOUNT_ID).toBe('account-1')
      expect(options.environment?.CLOUDFLARE_API_TOKEN).toBeUndefined()
      expect(options.forwardOutput).toBe(false)
      await writeFile(options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '', JSON.stringify({
        type: 'deploy', version: 1, targets: ['dsh-edge.owner.workers.dev'],
      }))
      return commandResult(0)
    })
    await installEdge({
      ui,
      runWrangler,
      environment: { CLOUDFLARE_API_TOKEN: 'must-not-override-profile' },
      createTemporaryDirectory: async () => directory,
    })

    expect(selectAccount).toHaveBeenNthCalledWith(
      1,
      expect.not.arrayContaining([expect.objectContaining({ value: 'temporary' })]),
    )
    expect(calls).toContainEqual(['auth', 'create', 'dsh-edge-install'])
    expect(calls).toContainEqual([
      'deployments', 'list', '--name', 'dsh-edge', '--json',
      '--env', 'isolated', '--profile', 'dsh-edge-install',
    ])
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
    const { ui, workerConflict } = createUi({
      accountSelections: ['account:account-1'],
      conflictAction: 'cancel',
    })
    const runWrangler = vi.fn()
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({
        loggedIn: true,
        accounts: [ACCOUNT],
      })))
      .mockResolvedValueOnce(commandResult(0, '[]'))

    await expect(installEdge({ ui, runWrangler })).rejects.toThrow('cancelled')
    expect(runWrangler).toHaveBeenCalledTimes(2)
    expect(workerConflict).toHaveBeenCalledWith('dsh-edge')
  })

  it('upgrades only an existing authenticated Worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-upgrade-test-'))
    const { ui, selectAccount, success, workerConflict } = createUi()
    const runWrangler = vi.fn(async (args: string[], options: RunOptions = {}): Promise<CommandResult> => {
      if (args[0] === 'whoami') {
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments' && args[1] === 'list') return commandResult(0, '[]')
      if (args[0] === 'deployments' && args[1] === 'status') {
        return commandResult(0, JSON.stringify({
          versions: [{ version_id: 'version-1', percentage: 100 }],
        }))
      }
      if (args[0] === 'versions') {
        return commandResult(0, JSON.stringify({
          resources: {
            bindings: [{ name: 'DSH_EDGE_INSTANCE', type: 'durable_object_namespace' }],
          },
        }))
      }
      if (args[0] === 'r2') return existingR2Bucket(args)!
      await writeFile(options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '', JSON.stringify({
        type: 'deploy', version: 1, targets: ['dsh-edge.owner.workers.dev'],
      }))
      return commandResult(0)
    })

    const result = await installEdge({
      command: 'upgrade', ui, runWrangler,
      createTemporaryDirectory: async () => directory,
    })

    expect(selectAccount).toHaveBeenCalledWith(expect.not.arrayContaining([
      expect.objectContaining({ value: 'temporary' }),
    ]))
    expect(workerConflict).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      attachmentStorage: 'private-r2',
      temporary: false,
      workerName: 'dsh-edge',
    })
    expect(success).toHaveBeenCalledOnce()
  })

  it('upgrades a claimed temporary Worker without provisioning or binding R2', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-upgrade-do-test-'))
    const { ui } = createUi()
    let deployedConfig: unknown
    const runWrangler = vi.fn(async (
      args: string[],
      options: RunOptions = {},
    ): Promise<CommandResult> => {
      if (args[0] === 'whoami') {
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments' && args[1] === 'list') return commandResult(0, '[]')
      if (args[0] === 'deployments' && args[1] === 'status') {
        return commandResult(0, JSON.stringify({
          versions: [{ version_id: 'temporary-version', percentage: 100 }],
        }))
      }
      if (args[0] === 'versions') {
        return commandResult(0, JSON.stringify({
          resources: { bindings: [{
            name: 'DSH_EDGE_ATTACHMENT_STORAGE',
            type: 'plain_text',
            text: 'temporary-do',
          }] },
        }))
      }
      expect(args[0]).toBe('deploy')
      const configPath = args[args.indexOf('--config') + 1]
      if (configPath === undefined) throw new Error('deploy command omitted its config path')
      deployedConfig = JSON.parse(await readFile(configPath, 'utf8')) as unknown
      await writeFile(options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '', JSON.stringify({
        type: 'deploy', version: 1, targets: ['dsh-edge.owner.workers.dev'],
      }))
      return commandResult(0)
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

  it('refuses to upgrade a missing Worker before collecting secrets', async () => {
    const { ui, selectOwnerSecretMode } = createUi()
    const runWrangler = vi.fn()
      .mockResolvedValueOnce(commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] })))
      .mockResolvedValueOnce(commandResult(1, '', '[code: 10007]'))

    await expect(installEdge({ command: 'upgrade', ui, runWrangler }))
      .rejects.toThrow('Run dsh-edge install first')
    expect(selectOwnerSecretMode).not.toHaveBeenCalled()
  })

  it('does not create a temporary account without explicit terms acceptance', async () => {
    const { ui } = createUi({
      accountSelections: ['temporary'],
      acceptTemporaryTerms: false,
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
      expect(await readFile(secretsPath, 'utf8')).toContain('sk-test')
      expect(options.signal).toBe(controller.signal)
      controller.abort(interrupted)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(await readFile(secretsPath, 'utf8')).toContain('sk-test')
      throw options.signal?.reason
    })

    await expect(installEdge({
      ui,
      runWrangler,
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
      expect(await readFile(secretsPath, 'utf8')).toContain('sk-test')
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
      createTemporaryDirectory: async () => directory,
    })).rejects.toBe(outputFailure)
    expect(outputFailureRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSecret: OWNER_SECRET, workerName: 'dsh-edge' }),
      'stdout',
    )
    await expect(stat(secretsPath)).rejects.toThrow()
    await expect(stat(directory)).rejects.toThrow()
  })

  it.each(['custom', 'generate'] as const)(
    'reports the active %s owner key when post-upload parsing fails',
    async (secretMode) => {
      const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
      const { ui, recovery, success } = createUi({ secretMode })
      const runWrangler = vi.fn(async (
        args: string[],
        options: RunOptions = {},
      ): Promise<CommandResult> => {
        if (args[0] === 'whoami') {
          return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
        }
        if (args[0] === 'deployments' && args[1] === 'list') return commandResult(0, '[]')
        if (args[0] === 'deployments' && args[1] === 'status') {
          return commandResult(0, JSON.stringify({
            versions: [{ version_id: 'version-1', percentage: 100 }],
          }))
        }
        if (args[0] === 'versions') {
          return commandResult(0, JSON.stringify({
            resources: {
              bindings: [{ name: 'DSH_EDGE_ATTACHMENTS', type: 'r2_bucket' }],
            },
          }))
        }
        if (args[0] === 'r2') return existingR2Bucket(args)!
        await writeFile(options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '', 'not-json')
        return commandResult(0)
      })

      await expect(installEdge({
        ui,
        runWrangler,
        createTemporaryDirectory: async () => directory,
      })).rejects.toThrow('malformed deployment metadata')

      expect(recovery).toHaveBeenCalledOnce()
      const details = recovery.mock.calls[0]?.[0] as InstallRecovery
      expect(details).toMatchObject({ workerName: 'dsh-edge' })
      if (secretMode === 'custom') expect(details.ownerSecret).toBe(OWNER_SECRET)
      else expect(validateOwnerSecret(details.ownerSecret)).toBeUndefined()
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
      if (args[0] === 'r2') return existingR2Bucket(args)!
      await writeFile(
        options.environment?.WRANGLER_OUTPUT_FILE_PATH ?? '',
        'x'.repeat(2 * 1024 * 1024 + 1),
      )
      return commandResult(0)
    })

    await expect(installEdge({
      ui,
      runWrangler,
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
      if (args[0] === 'r2') return existingR2Bucket(args)!
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
      if (args[0] === 'r2') return existingR2Bucket(args)!
      controller.abort(interrupted)
      return { ...commandResult(0, 'uploaded'), interrupted: true }
    })

    await expect(installEdge({
      ui,
      runWrangler,
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

  it('adds a Workers Paid recovery path to isolated deployment failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installer-test-'))
    const { ui } = createUi({ mode: 'isolated', accountSelections: ['account:account-1'] })
    const runWrangler = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'whoami') {
        return commandResult(0, JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }))
      }
      if (args[0] === 'deployments') return commandResult(1, '', '[code: 10007]')
      if (args[0] === 'r2') return existingR2Bucket(args)!
      return commandResult(1, '', 'Worker Loader is unavailable')
    })

    await expect(installEdge({
      ui,
      runWrangler,
      createTemporaryDirectory: async () => directory,
    })).rejects.toThrow('Workers Paid plan')
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
    const r2 = existingR2Bucket(args)
    if (r2 !== undefined) return r2
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

function createUi({
  mode = 'direct',
  accountSelections = ['account:account-1'],
  conflictAction = 'update',
  acceptTemporaryTerms = true,
  secretMode = 'custom',
}: {
  mode?: RuntimeMode
  accountSelections?: string[]
  conflictAction?: 'rename' | 'update' | 'cancel'
  acceptTemporaryTerms?: boolean
  secretMode?: 'generate' | 'custom'
} = {}): {
  ui: InstallerUi
  activationFinish: Mock
  activationStart: Mock
  cleanupFailure: Mock
  deploymentFinish: Mock
  deploymentStart: Mock
  failedDeployment: Mock
  outputFailureRecovery: Mock
  recovery: Mock
  selectAccount: Mock
  selectOwnerSecretMode: Mock
  success: Mock
  workerConflict: Mock
} {
  const selectAccount = vi.fn()
    .mockImplementation(async () => accountSelections.shift() ?? 'account:account-1')
  const selectOwnerSecretMode = vi.fn().mockResolvedValue(secretMode)
  const success = vi.fn()
  const recovery = vi.fn()
  const outputFailureRecovery = vi.fn()
  const cleanupFailure = vi.fn()
  const deploymentStart = vi.fn()
  const deploymentFinish = vi.fn()
  const activationStart = vi.fn()
  const activationFinish = vi.fn()
  const failedDeployment = vi.fn()
  const workerConflict = vi.fn().mockResolvedValue(conflictAction)
  const ui: InstallerUi = {
    intro: vi.fn(),
    step: vi.fn(),
    selectRuntime: vi.fn().mockResolvedValue(mode),
    selectAccount,
    workerName: vi.fn().mockImplementation(async (initialValue: string) => initialValue),
    workerConflict,
    selectOwnerSecretMode,
    ownerSecret: vi.fn().mockResolvedValue(OWNER_SECRET),
    deepSeekKey: vi.fn().mockResolvedValue('sk-test'),
    confirm: vi.fn().mockResolvedValue(true),
    acceptTemporaryTerms: vi.fn().mockResolvedValue(acceptTemporaryTerms),
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
    deploymentFinish,
    deploymentStart,
    failedDeployment,
    outputFailureRecovery,
    recovery,
    selectAccount,
    selectOwnerSecretMode,
    success,
    workerConflict,
  }
}
