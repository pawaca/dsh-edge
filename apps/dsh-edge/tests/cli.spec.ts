import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import * as prompt from '@clack/prompts'
import { describe, expect, it, vi } from 'vitest'
import {
  createInstallerUi,
  InstallInterruptedError,
  parseCommand,
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
    const pending = createInstallerUi(clack, controller.signal).selectRuntime()

    controller.abort(interrupted)

    await expect(pending).rejects.toBe(interrupted)
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
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
        publicUrl: 'https://dsh-edge.example.workers.dev',
        mode: 'direct' as const,
        ownerSecret: 'active-owner-key',
        temporary: false,
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

  it('shows one deployment status and a recoverable temporary-account failure', () => {
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
  })

  it('hands an authenticated deployment to the owner without claiming readiness', () => {
    const note = vi.fn()
    const outro = vi.fn()
    const clack = { ...prompt, note, outro } as unknown as typeof prompt

    createInstallerUi(clack).success({
      publicUrl: 'https://dsh-edge.example.workers.dev',
      account: { id: 'account-1', name: 'Personal' },
      mode: 'direct',
      ownerSecret: 'active-owner-key',
      temporary: false,
      workerName: 'dsh-edge',
    })

    expect(note).toHaveBeenCalledWith(expect.stringContaining(
      '1. Open the URL above.\n2. Enter the owner access key when prompted.',
    ), 'dsh-edge installed')
    expect(outro).toHaveBeenCalledWith('Installation handoff complete.')
  })

  it('puts account claim before opening a temporary deployment', () => {
    const note = vi.fn()
    const clack = { ...prompt, note, outro: vi.fn() } as unknown as typeof prompt

    createInstallerUi(clack).success({
      publicUrl: 'https://dsh-edge.preview.workers.dev',
      claimUrl: 'https://dash.cloudflare.com/claim-preview?token=claim-secret',
      mode: 'direct',
      ownerSecret: 'active-owner-key',
      temporary: true,
      workerName: 'dsh-edge',
    })

    expect(note).toHaveBeenCalledWith(expect.stringContaining(
      '1. Claim this temporary account within 60 minutes to keep the Worker and its data.\n'
      + '2. Open the URL above.\n3. Enter the owner access key when prompted.',
    ), 'dsh-edge installed')
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
