import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import * as prompt from '@clack/prompts'
import { describe, expect, it, vi } from 'vitest'
import edgePackage from '../package.json' with { type: 'json' }
import {
  browserOpenCommand,
  createInstallerUi,
  InstallInterruptedError,
  parseCommand,
  renderInstallerIntro,
  runInstaller,
} from '../scripts/cli.mjs'
import { InstallerOutputError } from '../scripts/install.mjs'
import type {
  CommandResult,
  executeWrangler,
  installEdge,
  InstallRecovery,
  InstallerUi,
} from '../scripts/install.mjs'

interface SelectPrompt {
  message: string
  initialValue?: string
  options: Array<{ value: string; hint?: string }>
}

function selectMock(answer: string) {
  return vi.fn(async (_prompt: SelectPrompt) => answer)
}

function recoveryUiFactory(outputFailureRecovery: InstallerUi['outputFailureRecovery']) {
  return (
    _signal: AbortSignal,
    output: Writable,
    writeRecovery: (
      failedStream: 'stderr' | 'stdout',
      value: string,
    ) => Promise<boolean>,
  ) => ({
    recovery: vi.fn(() => output.write('pending status')),
    outputFailureRecovery(result: InstallRecovery, failedStream: 'stderr' | 'stdout') {
      void outputFailureRecovery(result, failedStream)
      return writeRecovery(
        failedStream,
        `Active owner access key: ${result.ownerSecret}`,
      )
    },
  }) as never
}

function recoveryInstall(recovery: InstallRecovery) {
  return vi.fn(async ({ ui, signal }: { ui: InstallerUi; signal: AbortSignal }) => {
    ui.recovery(recovery)
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error
          ? signal.reason
          : new Error('Installer aborted without an Error reason.'))
      }, { once: true })
    })
  })
}

describe('dsh-edge CLI', () => {
  it('parses installer, help, and version operations', () => {
    expect(parseCommand(['install'])).toBe('install')
    expect(parseCommand(['install', '--verbose'])).toBe('install')
    expect(parseCommand(['--verbose', 'upgrade'])).toBe('upgrade')
    expect(parseCommand(['upgrade'])).toBe('upgrade')
    expect(parseCommand([])).toBe('help')
    expect(parseCommand(['--version'])).toBe('version')
    expect(() => parseCommand(['install', '--verbose', '--verbose'])).toThrow('Usage')
    expect(() => parseCommand(['deploy'])).toThrow('Usage: dsh-edge <install|upgrade>')
  })

  it('executes the shipped CLI entry point', () => {
    const cli = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('Usage: dsh-edge <install|upgrade>')
  })

  it('renders a product hero only when the terminal has room for it', () => {
    const hero = renderInstallerIntro('install', {
      columns: 100,
      isTTY: true,
      version: '0.3.0-alpha.1',
      upstreamVersion: '0.1.1-rc.1',
    })
    const lines = hero.split('\n')
    expect(lines[0]).toBe('')
    expect(lines[1]).toBe(' ____  ____  _   _       _____ ____   ____ _____')
    expect(lines[2]).toBe('|  _ \\/ ___|| | | |     | ____|  _ \\ / ___| ____|')
    expect(hero).toContain('DeepSeek Harness on Cloudflare')
    expect(hero).toContain('dsh-edge 0.3.0-alpha.1 · Harness 0.1.1-rc.1')
    expect(hero).toContain('community project · install')
    expect(renderInstallerIntro('upgrade', {
      columns: 60,
      isTTY: true,
      version: '0.3.0-alpha.1',
      upstreamVersion: '0.1.1-rc.1',
    })).toBe('dsh-edge upgrade · 0.3.0-alpha.1 · Harness 0.1.1-rc.1')
    expect(renderInstallerIntro('install', {
      columns: 100,
      isTTY: false,
      version: '0.3.0-alpha.1',
      upstreamVersion: '0.1.1-rc.1',
    })).toBe('dsh-edge install · 0.3.0-alpha.1 · Harness 0.1.1-rc.1')
  })

  it('executes through a package-manager-style bin symlink', () => {
    const cli = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))
    const directory = mkdtempSync(join(tmpdir(), 'dsh-edge-bin-'))
    const bin = join(directory, 'dsh-edge')
    try {
      symlinkSync(cli, bin, 'file')
      const result = spawnSync(process.execPath, [bin], { encoding: 'utf8' })

      expect(result.status).toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('Usage: dsh-edge <install|upgrade>')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('passes the process interruption signal to a pending prompt', async () => {
    const controller = new AbortController()
    const interrupted = new Error('interrupted by SIGTERM')
    const select = vi.fn(async (options: { signal?: AbortSignal }) => {
      return await new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(interrupted)
        }, { once: true })
      })
    })
    const clack = { ...prompt, select } as unknown as typeof prompt
    const pending = createInstallerUi(clack, controller.signal).selectCapability()

    controller.abort(interrupted)

    await expect(pending).rejects.toBe(interrupted)
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
  })

  it('offers only another name for a Worker that is not dsh-edge', async () => {
    const select = selectMock('rename')
    const clack = { ...prompt, select } as unknown as typeof prompt

    await expect(createInstallerUi(clack).nameTaken('dsh-edge')).resolves.toBe('rename')
    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      message: 'dsh-edge is already used by a Worker that is not dsh-edge',
      initialValue: 'rename',
      options: [
        { value: 'rename', label: 'Use another name' },
        { value: 'cancel', label: 'Cancel' },
      ],
    }))
  })

  it('offers an existing Worker as an in-place update that Enter confirms', async () => {
    const select = selectMock('update')
    const note = vi.fn()
    const clack = { ...prompt, note, select } as unknown as typeof prompt

    await expect(createInstallerUi(clack).existingWorker({ workerName: 'dsh-edge', mode: 'container', sessionFormatUpgrade: true }))
      .resolves.toBe('update')

    expect(note).toHaveBeenCalledWith([
      'Can:   research and write, analyze data and split big jobs, work on code projects',
      `After: dsh-edge ${edgePackage.version} with the same capabilities`,
      'Kept:  conversations, files, access key, and DeepSeek key',
      'The first command after this can take a few minutes while the container image rolls out.',
      'Stored sessions move to a new format when this release first starts, writing about two storage rows per stored row (on Workers Free, a large instance can exceed the daily write allowance). Rolling back to an earlier dsh-edge release afterwards is not supported.',
    ].join('\n'), 'dsh-edge already exists')
    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Update dsh-edge?',
      initialValue: 'update',
    }))
    expect(select.mock.calls[0]?.[0].options.map(option => option.value))
      .toEqual(['update', 'change', 'rename', 'cancel'])
  })

  it('asks what the agent should do, marking an existing instance\'s capabilities', async () => {
    const select = selectMock('isolated')
    const clack = { ...prompt, select } as unknown as typeof prompt
    const ui = createInstallerUi(clack)

    await ui.selectCapability()
    expect(select).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'What should your agent be able to do?',
      initialValue: 'direct',
    }))
    await ui.selectCapability('isolated')
    expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ initialValue: 'isolated' }))
    expect(select.mock.lastCall?.[0].options[1]?.hint).toMatch(/ · current$/u)
    expect(select.mock.lastCall?.[0].options[0]?.hint).not.toMatch(/current/u)
  })

  it('defaults a downgrade to No after naming what it removes', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const note = vi.fn()
    const clack = { ...prompt, confirm, note } as unknown as typeof prompt

    await expect(createInstallerUi(clack).confirmDowngrade(['work on code projects'])).resolves.toBe(false)
    expect(note).toHaveBeenCalledWith(expect.stringContaining('This removes: work on code projects.'),
      'Fewer capabilities')
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }))
  })

  it('confirms once, listing the price, the defaults, and a temporary account\'s terms', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const note = vi.fn()
    const clack = { ...prompt, confirm, note } as unknown as typeof prompt
    const ui = createInstallerUi(clack)

    await ui.confirm({
      mode: 'direct',
      accountLabel: 'Temporary account',
      workerName: 'dsh-edge',
      temporary: true,
      updating: false,
      attachmentStorage: 'temporary-do',
    })
    expect(note).toHaveBeenLastCalledWith(expect.stringMatching(/^Cost: +free on Workers Free$/mu), 'Install dsh-edge')
    expect(note.mock.lastCall?.[0]).toMatch(/^DeepSeek: +add your API key when the web app asks, or later in Settings → Models$/mu)
    expect(note.mock.lastCall?.[0]).toContain('https://www.cloudflare.com/terms/')
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'Accept the terms and install?',
      initialValue: true,
    }))

    await ui.confirm({
      mode: 'container',
      accountLabel: 'Personal',
      workerName: 'dsh-edge',
      temporary: false,
      updating: true,
      attachmentStorage: 'private-r2',
    })
    expect(note.mock.lastCall?.[0]).toContain('Workers Paid on this account')
    expect(note.mock.lastCall?.[0]).toMatch(/^Kept: +conversations, files, access key, and DeepSeek key$/mu)
    expect(note.mock.lastCall?.[0]).not.toContain('terms')
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Update this instance?' }))
  })

  it('offers only a retry when a Worker\'s R2 storage is not enabled', async () => {
    const select = selectMock('retry')
    const note = vi.fn()
    const clack = { ...prompt, note, select } as unknown as typeof prompt

    await expect(createInstallerUi(clack).r2SubscriptionUnavailable({
      activationUrl: 'https://dash.cloudflare.com/account-1/r2/overview',
    })).resolves.toBe('retry')

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('https://dash.cloudflare.com/account-1/r2/overview'),
      'R2 is not enabled for this account',
    )
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ initialValue: 'retry' }))
    expect(select.mock.calls[0]?.[0].options.map(option => option.value))
      .toEqual(['retry', 'cancel'])
  })

  it('opens the instance in a browser when the owner presses Enter at the end', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const openUrl = vi.fn().mockResolvedValue(false)
    const warn = vi.fn()
    const clack = {
      ...prompt, confirm, note: vi.fn(), outro: vi.fn(), log: { ...prompt.log, warn },
    } as unknown as typeof prompt
    const output = Object.assign(new Writable({ write: (_chunk, _encoding, callback) => callback() }), {
      isTTY: true,
    })

    await createInstallerUi(clack, undefined, undefined, output, undefined, 'install', openUrl).success({
      activation: { attempts: 1, elapsedMs: 0, status: 'ready' },
      attachmentStorage: 'temporary-do',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      mode: 'direct',
      ownerSecret: 'active-owner-key',
      temporary: false,
      updated: false,
      workerName: 'dsh-edge',
    })

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Open dsh-edge in your browser?',
      initialValue: true,
    }))
    expect(openUrl).toHaveBeenCalledWith('https://dsh-edge.example.workers.dev')
    expect(warn).toHaveBeenCalledWith('Could not open a browser. Open the URL above.', { output })
    expect(browserOpenCommand('https://x.workers.dev', 'darwin')).toEqual({ command: 'open', args: ['https://x.workers.dev'] })
    expect(browserOpenCommand('https://x.workers.dev', 'linux').command).toBe('xdg-open')
    expect(browserOpenCommand('https://x.workers.dev', 'win32')).toEqual({
      command: 'rundll32', args: ['url.dll,FileProtocolHandler', 'https://x.workers.dev'],
    })
  })

  it.each([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('routes %s through the installer abort lifecycle with exit code %i', async (
    processSignal,
    exitCode,
  ) => {
    const runtimeProcess = new EventEmitter()
    const cleanup = vi.fn()
    const install = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      try {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error
              ? signal.reason
              : new Error('Installer aborted without an Error reason.'))
          }, { once: true })
        })
      } finally {
        cleanup()
      }
    })
    const pending = runInstaller({ install, installerUi: {} as never, runtimeProcess })

    runtimeProcess.emit(processSignal)

    await expect(pending).rejects.toMatchObject({
      exitCode,
      signal: processSignal,
    } satisfies Partial<InstallInterruptedError>)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(runtimeProcess.listenerCount(processSignal)).toBe(0)
  })

  it('keeps post-upload output failures managed until cleanup and alternate recovery complete', async () => {
    const order: string[] = []
    const brokenOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
      },
    })
    const recovery = {
      ownerSecret: 'active-owner-key',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      workerName: 'dsh-edge',
    }
    const outputFailureRecovery = vi.fn((_result, stream) => {
      order.push(`alternate:${stream}`)
    })
    const uiFactory = (_signal: AbortSignal, output: Writable) => ({
      recovery: vi.fn(() => output.write('verification failed')),
      outputFailureRecovery,
    }) as never
    const install = vi.fn(async ({ ui, signal }: { ui: InstallerUi; signal: AbortSignal }) => {
      try {
        ui.recovery(recovery)
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error
              ? signal.reason
              : new Error('Installer aborted without an Error reason.'))
          }, { once: true })
        })
      } finally {
        order.push('cleanup')
      }
    })

    await expect(runInstaller({ install, uiFactory, stdout: brokenOutput })).rejects.toMatchObject({
      stream: 'stdout',
    } satisfies Partial<InstallerOutputError>)
    expect(outputFailureRecovery).toHaveBeenCalledWith(recovery, 'stdout')
    expect(order).toEqual(['cleanup', 'alternate:stdout'])
  })

  it('cancels a blocked recovery write on interruption and preserves signal exit semantics', async () => {
    const runtimeProcess = new EventEmitter()
    const order: string[] = []
    const blockedOutput = new Writable({
      write() {
        // Simulate a pipe whose consumer remains open but no longer reads.
      },
    })
    const recovery = {
      ownerSecret: 'active-owner-key',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      workerName: 'dsh-edge',
    }
    const outputFailureRecovery = vi.fn((_result, stream) => {
      order.push(`alternate:${stream}`)
    })
    const uiFactory = (_signal: AbortSignal, output: Writable) => ({
      recovery: vi.fn(() => output.write('queued recovery key')),
      outputFailureRecovery,
    }) as never
    const install = vi.fn(async ({ ui, signal }: { ui: InstallerUi; signal: AbortSignal }) => {
      try {
        ui.recovery(recovery)
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error
              ? signal.reason
              : new Error('Installer aborted without an Error reason.'))
          }, { once: true })
        })
      } finally {
        order.push('cleanup')
      }
    })
    const pending = runInstaller({ install, runtimeProcess, uiFactory, stdout: blockedOutput })

    runtimeProcess.emit('SIGINT')

    await expect(pending).rejects.toMatchObject({ exitCode: 130, signal: 'SIGINT' })
    expect(outputFailureRecovery).toHaveBeenCalledWith(recovery, 'stdout')
    expect(order).toEqual(['cleanup', 'alternate:stdout'])
    expect(blockedOutput.destroyed).toBe(true)
  })

  it('lets a later signal settle stdout blocked after a stderr failure', async () => {
    const runtimeProcess = new EventEmitter()
    const stdout = new Writable({
      write() {
        // Keep stdout pending after stderr triggers the first abort.
      },
    })
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    const recovery = {
      ownerSecret: 'active-owner-key',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      workerName: 'dsh-edge',
    }
    const outputFailureRecovery = vi.fn()
    const uiFactory = recoveryUiFactory(outputFailureRecovery)
    const install = recoveryInstall(recovery)
    const pending = runInstaller({ install, runtimeProcess, stderr, stdout, uiFactory })

    stderr.emit('error', new Error('stderr closed'))
    runtimeProcess.emit('SIGTERM')

    await expect(pending).rejects.toMatchObject({
      exitCode: 143,
      outputFailureStream: 'stderr',
      signal: 'SIGTERM',
    })
    expect(outputFailureRecovery).toHaveBeenCalledWith(recovery, 'stderr')
    expect(stdout.destroyed).toBe(true)
  })

  it('bounds stdout draining after stderr fails without another signal', async () => {
    const stdout = new Writable({
      write() {
        // Keep the surviving destination permanently backpressured.
      },
    })
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    const recovery = {
      ownerSecret: 'active-owner-key',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      workerName: 'dsh-edge',
    }
    const outputFailureRecovery = vi.fn()
    const uiFactory = recoveryUiFactory(outputFailureRecovery)
    const install = recoveryInstall(recovery)
    const pending = runInstaller({
      install,
      outputDrainTimeoutMs: 1,
      stderr,
      stdout,
      uiFactory,
    })

    stderr.emit('error', new Error('stderr closed'))

    await expect(pending).rejects.toMatchObject({ stream: 'stderr' })
    expect(outputFailureRecovery).toHaveBeenCalledWith(recovery, 'stderr')
    expect(stdout.destroyed).toBe(true)
  })

  it('routes Wrangler output through the cancellable CLI destination boundary', async () => {
    const runtimeProcess = new EventEmitter()
    const blockedOutput = new Writable({
      write() {
        // Keep the underlying pipe write pending until the signal path destroys it.
      },
    })
    const wranglerRunner = vi.fn(async (
      _args: string[],
      options: Parameters<typeof executeWrangler>[1],
    ): Promise<CommandResult> => {
      expect(options?.stdoutDestination).not.toBe(blockedOutput)
      options?.stdoutDestination?.write('blocked Wrangler output')
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error('Wrangler aborted without an Error reason.'))
        }, { once: true })
      })
      return { status: 0, stderr: '', stdout: '' }
    })
    const installEdgeImpl = vi.fn(async ({
      runWrangler,
      signal,
    }: Parameters<typeof installEdge>[0]) => {
      await runWrangler?.([], {
        interactive: true,
        ...(signal === undefined ? {} : { signal }),
      })
      throw new Error('Wrangler unexpectedly completed.')
    })
    const pending = runInstaller({
      installEdgeImpl,
      runtimeProcess,
      stdout: blockedOutput,
      uiFactory: () => ({}) as never,
      wranglerRunner,
    })

    runtimeProcess.emit('SIGTERM')

    await expect(pending).rejects.toMatchObject({ exitCode: 143, signal: 'SIGTERM' })
    expect(wranglerRunner).toHaveBeenCalledOnce()
    expect(blockedOutput.destroyed).toBe(true)
  })

  it.each([
    ['interactive authentication', false, { interactive: true }, true],
    ['quiet deployment', false, { interactive: true, forwardOutput: false }, false],
    ['verbose deployment', true, { interactive: true, forwardOutput: false }, true],
  ] as const)('selects Wrangler output forwarding for %s', async (
    _scenario,
    verbose,
    runOptions,
    expected,
  ) => {
    const wranglerRunner = vi.fn(async (): Promise<CommandResult> => ({
      status: 0,
      stderr: '',
      stdout: '',
    }))
    const installEdgeImpl = vi.fn(async ({
      runWrangler,
    }: Parameters<typeof installEdge>[0]) => {
      await runWrangler?.([], runOptions)
      return {
        attachmentStorage: 'private-r2' as const,
        publicUrl: 'https://dsh-edge.example.workers.dev',
        mode: 'direct' as const,
        ownerSecret: 'active-owner-key',
        temporary: false,
        updated: false,
        workerName: 'dsh-edge',
      }
    })

    await runInstaller({
      installEdgeImpl,
      runtimeProcess: new EventEmitter(),
      uiFactory: () => ({}) as never,
      verbose,
      wranglerRunner,
    })

    expect(wranglerRunner).toHaveBeenCalledWith([], expect.objectContaining({
      forwardOutput: expected,
    }))
  })

  it('uses stdout for recovery when only Wrangler stderr is blocked on interruption', async () => {
    const runtimeProcess = new EventEmitter()
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    const blockedStderr = new Writable({
      write() {
        // Keep the underlying stderr write pending until the signal path destroys it.
      },
    })
    const recovery = {
      ownerSecret: 'active-owner-key',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      workerName: 'dsh-edge',
    }
    const outputFailureRecovery = vi.fn()
    const wranglerRunner = vi.fn(async (
      _args: string[],
      options: Parameters<typeof executeWrangler>[1],
    ): Promise<CommandResult> => {
      options?.stderrDestination?.write('blocked Wrangler diagnostic')
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error('Wrangler aborted without an Error reason.'))
        }, { once: true })
      })
      return { status: 0, stderr: '', stdout: '' }
    })
    const installEdgeImpl = vi.fn(async ({
      runWrangler,
      signal,
      ui,
    }: Parameters<typeof installEdge>[0]) => {
      ui?.recovery(recovery)
      await runWrangler?.([], {
        interactive: true,
        ...(signal === undefined ? {} : { signal }),
      })
      throw new Error('Wrangler unexpectedly completed.')
    })
    const pending = runInstaller({
      installEdgeImpl,
      runtimeProcess,
      stderr: blockedStderr,
      stdout,
      uiFactory: () => ({ recovery: vi.fn(), outputFailureRecovery }) as never,
      wranglerRunner,
    })

    runtimeProcess.emit('SIGTERM')

    await expect(pending).rejects.toMatchObject({
      exitCode: 143,
      outputFailureStream: 'stderr',
      signal: 'SIGTERM',
    })
    expect(outputFailureRecovery).toHaveBeenCalledWith(recovery, 'stderr')
    expect(blockedStderr.destroyed).toBe(true)
    expect(stdout.destroyed).toBe(false)
  })

  it('prints the active owner key when an upload needs recovery', () => {
    const note = vi.fn()
    const clack = { ...prompt, note } as unknown as typeof prompt

    createInstallerUi(clack).recovery({
      ownerSecret: 'active-owner-key',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      workerName: 'dsh-edge',
    })

    expect(note).toHaveBeenCalledWith(expect.stringContaining(
      'Active owner access key: active-owner-key',
    ), 'Worker uploaded — recovery details')
  })

  it('shows upload and activation status without turning pending activation into failure', () => {
    const start = vi.fn()
    const stop = vi.fn()
    const error = vi.fn()
    const note = vi.fn()
    const clack = {
      ...prompt,
      note,
      spinner: vi.fn(() => ({ error, start, stop })),
    } as unknown as typeof prompt
    const ui = createInstallerUi(clack)

    ui.deploymentStart?.('Installing the tested Worker release…')
    ui.deploymentFinish?.(false)
    ui.failedDeployment?.({
      claimUrl: 'https://dash.cloudflare.com/claim-preview?token=claim-secret',
      workerName: 'dsh-edge',
    })

    expect(start).toHaveBeenCalledWith('Installing the tested Worker release…')
    expect(error).toHaveBeenCalledWith('Cloudflare did not accept the Worker upload.')
    expect(stop).not.toHaveBeenCalled()
    expect(note).toHaveBeenCalledWith(expect.stringContaining(
      'Status: the Worker was not installed.',
    ), 'Installation did not complete')
    expect(note).toHaveBeenCalledWith(expect.not.stringContaining('owner access key'),
      'Installation did not complete')

    ui.activationStart?.('Activating the public URL… Cloudflare usually takes 10–30 seconds.')
    ui.activationFinish?.({ attempts: 20, elapsedMs: 45_000, status: 'pending' })
    expect(start).toHaveBeenLastCalledWith(
      'Activating the public URL… Cloudflare usually takes 10–30 seconds.',
    )
    expect(stop).toHaveBeenLastCalledWith(
      'Worker uploaded; application readiness is not yet verified.',
    )
  })

  // `confirm` declines the browser in case the test runner's stdout is a TTY.
  it('hands a pending authenticated deployment to the owner without claiming readiness', async () => {
    const note = vi.fn()
    const outro = vi.fn()
    const clack = { ...prompt, confirm: vi.fn().mockResolvedValue(false), note, outro } as unknown as typeof prompt

    await createInstallerUi(clack).success({
      attachmentStorage: 'private-r2',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      account: { id: 'account-1', name: 'Personal' },
      mode: 'direct',
      ownerSecret: 'active-owner-key',
      temporary: false,
      updated: false,
      workerName: 'dsh-edge',
    })

    expect(note).toHaveBeenCalledWith(expect.stringContaining(
      'Status: Application readiness has not been verified.',
    ), 'Worker uploaded — readiness unverified')
    expect(note).toHaveBeenCalledWith(expect.stringContaining(
      '1. Open the URL above.\n2. Enter the owner access key when prompted.\n'
      + '3. Add your DeepSeek API key when the web app asks (or later in Settings → Models).\n'
      + '4. Save the owner access key; you need it to sign in.',
    ), 'Worker uploaded — readiness unverified')
    expect(outro).toHaveBeenCalledWith(
      'Worker uploaded; application readiness remains unverified.',
    )
  })

  it('celebrates a deployment only after the exact public release is ready', async () => {
    const note = vi.fn()
    const outro = vi.fn()
    const clack = { ...prompt, confirm: vi.fn().mockResolvedValue(false), note, outro } as unknown as typeof prompt

    await createInstallerUi(clack).success({
      activation: { attempts: 3, elapsedMs: 3_000, status: 'ready' },
      attachmentStorage: 'private-r2',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      account: { id: 'account-1', name: 'Personal' },
      mode: 'direct',
      ownerSecret: 'active-owner-key',
      temporary: false,
      updated: false,
      workerName: 'dsh-edge',
    })

    expect(note).toHaveBeenCalledWith(expect.stringContaining('Status: Ready'),
      'dsh-edge is ready')
    expect(outro).toHaveBeenCalledWith('Your dsh-edge is ready.')
  })

  it('hands over an in-place update without a new key', async () => {
    const note = vi.fn()
    const outro = vi.fn()
    const clack = { ...prompt, confirm: vi.fn().mockResolvedValue(false), note, outro } as unknown as typeof prompt

    await createInstallerUi(clack).success({
      activation: { attempts: 1, elapsedMs: 0, status: 'live' },
      attachmentStorage: 'temporary-do',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      mode: 'isolated',
      temporary: false,
      updated: true,
      workerName: 'dsh-edge',
    })

    expect(note).toHaveBeenCalledWith(expect.stringContaining('Owner access key: unchanged'),
      'dsh-edge update is live')
    expect(note.mock.lastCall?.[0]).toContain(
      '1. Open the URL above.\n2. Sign in with your existing owner access key.',
    )
    expect(note.mock.lastCall?.[0]).not.toContain('DeepSeek')
    expect(outro).toHaveBeenCalledWith('Your dsh-edge update is live.')
  })

  it('puts account claim before opening a temporary deployment', async () => {
    const note = vi.fn()
    const clack = {
      ...prompt, confirm: vi.fn().mockResolvedValue(false), note, outro: vi.fn(),
    } as unknown as typeof prompt

    await createInstallerUi(clack).success({
      attachmentStorage: 'temporary-do',
      publicUrl: 'https://dsh-edge.preview.workers.dev',
      claimUrl: 'https://dash.cloudflare.com/claim-preview?token=claim-secret',
      mode: 'direct',
      ownerSecret: 'active-owner-key',
      temporary: true,
      updated: false,
      workerName: 'dsh-edge',
    })

    expect(note).toHaveBeenCalledWith(expect.stringContaining(
      '1. Claim this temporary account within 60 minutes to keep the Worker and its data.\n'
      + '2. Open the URL above.\n3. Enter the owner access key when prompted.',
    ), 'Worker uploaded — readiness unverified')
  })

  it.each([
    ['stdout', 2],
    ['stderr', 1],
  ] as const)('writes %s-failure recovery to file descriptor %i', (failedStream, descriptor) => {
    const writeDescriptor = vi.fn().mockReturnValue(0)

    void createInstallerUi(prompt, undefined, writeDescriptor).outputFailureRecovery({
      ownerSecret: 'active-owner-key',
      publicUrl: 'https://dsh-edge.example.workers.dev',
      workerName: 'dsh-edge',
    }, failedStream)

    expect(writeDescriptor).toHaveBeenCalledWith(
      descriptor,
      expect.stringContaining('Active owner access key: active-owner-key'),
    )
  })

  it('continues cleanup when both process output streams are unavailable', () => {
    const writeDescriptor = vi.fn(() => { throw new Error('broken pipe') })

    expect(() => {
      void createInstallerUi(prompt, undefined, writeDescriptor).outputFailureRecovery({
        ownerSecret: 'active-owner-key',
        workerName: 'dsh-edge',
      }, 'stdout')
    }).not.toThrow()
  })

  it('warns without replacing the primary outcome when final cleanup also fails', () => {
    const warn = vi.fn()
    const clack = {
      ...prompt,
      log: { ...prompt.log, warn },
    } as unknown as typeof prompt

    createInstallerUi(clack).cleanupFailure('Could not remove private temporary files: locked')

    expect(warn).toHaveBeenCalledWith('Could not remove private temporary files: locked')
  })
})
