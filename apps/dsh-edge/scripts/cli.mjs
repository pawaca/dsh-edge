#!/usr/bin/env node

import * as prompt from '@clack/prompts'
import { realpathSync, writeSync } from 'node:fs'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import edgePackage from '../package.json' with { type: 'json' }
import { observePublicActivation } from './activation.mjs'
import {
  executeWrangler,
  InstallCancelledError,
  InstallerOutputError,
  installEdge,
} from './install.mjs'

const INTERRUPT_EXIT_CODES = new Map([
  ['SIGHUP', 129],
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
const OUTPUT_DRAIN_TIMEOUT_MS = 1_000
const HERO_MIN_COLUMNS = 68
const DSH_EDGE_HERO = String.raw` ____  ____  _   _       _____ ____   ____ _____
|  _ \/ ___|| | | |     | ____|  _ \ / ___| ____|
| | | \___ \| |_| |_____|  _| | | | | |  _|  _|
| |_| |___) |  _  |_____| |___| |_| | |_| | |___
|____/|____/|_| |_|     |_____|____/ \____|_____|`

export class InstallInterruptedError extends InstallCancelledError {
  constructor(signal) {
    super()
    this.exitCode = INTERRUPT_EXIT_CODES.get(signal)
    this.signal = signal
  }
}

export function parseCommand(args) {
  if (args.filter(arg => arg === '--verbose').length > 1) throw usageError()
  const operation = args.filter(arg => arg !== '--verbose')
  if (operation.length === 1 && (operation[0] === 'install' || operation[0] === 'upgrade')) {
    return operation[0]
  }
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) return 'help'
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return 'version'
  throw usageError()
}

export function renderInstallerIntro(command, {
  columns = 80,
  isTTY = false,
  version = edgePackage.version,
  upstreamVersion = edgePackage.dshEdge.upstreamVersion,
} = {}) {
  if (!isTTY || columns < HERO_MIN_COLUMNS) {
    return `dsh-edge ${command} · ${version} · Harness ${upstreamVersion}`
  }
  return [
    '',
    DSH_EDGE_HERO,
    '',
    'DeepSeek Harness on Cloudflare',
    `dsh-edge ${version} · Harness ${upstreamVersion}`,
    `community project · ${command}`,
  ].join('\n')
}

export function createInstallerUi(
  clack = prompt,
  signal,
  writeDescriptor = writeSync,
  output,
  writeRecovery,
  command = 'install',
) {
  const withOutput = options => output === undefined ? options : { ...options, output }
  const log = (writer, message) => output === undefined
    ? writer(message)
    : writer(message, { output })
  const note = (message, title) => output === undefined
    ? clack.note(message, title)
    : clack.note(message, title, { output })
  let deploymentSpinner
  let activationSpinner
  const terminal = output ?? process.stdout
  return {
    intro: () => log(clack.intro, renderInstallerIntro(command, {
      columns: terminal.columns ?? 80,
      isTTY: terminal.isTTY === true,
    })),
    step: message => log(clack.log.step, message),
    async selectRuntime() {
      return await requireAnswer(await clack.select(withOutput({
        message: 'Choose a runtime',
        signal,
        initialValue: 'direct',
        options: [
          {
            value: 'direct',
            label: 'Free — Direct Shell',
            hint: 'recommended; runs on Workers Free',
          },
          {
            value: 'isolated',
            label: 'Isolated — Dynamic Worker',
            hint: 'requires Workers Paid (starting at $5/month)',
          },
        ],
      })))
    },
    async selectAccount(choices) {
      return await requireAnswer(await clack.select(withOutput({
        message: 'Choose a Cloudflare account',
        options: choices,
        signal,
      })))
    },
    async workerName(initialValue, validate) {
      return await requireAnswer(await clack.text(withOutput({
        message: 'Worker name',
        initialValue,
        signal,
        validate,
      })))
    },
    async workerConflict(workerName) {
      return await requireAnswer(await clack.select(withOutput({
        message: `${workerName} already exists`,
        signal,
        options: [
          { value: 'rename', label: 'Choose another name' },
          { value: 'update', label: 'Update this Worker', hint: 'keeps its Durable Object data' },
          { value: 'cancel', label: 'Cancel' },
        ],
      })))
    },
    async selectInitialAttachmentStorage() {
      note([
        'This Worker predates image attachments, so no existing image references need migration.',
        'The selected backend is pinned for future upgrades and is not changed automatically.',
      ].join('\n'), 'Choose image storage once')
      return await requireAnswer(await clack.select(withOutput({
        message: 'Where should this Worker store new images?',
        initialValue: 'temporary-do',
        signal,
        options: [
          {
            value: 'temporary-do',
            label: 'Durable Object — no R2 setup',
            hint: 'recommended for Workers Free; 64 MiB per instance',
          },
          {
            value: 'private-r2',
            label: 'Private R2 bucket',
            hint: 'requires an enabled R2 subscription; includes a free tier',
          },
        ],
      })))
    },
    async r2SubscriptionUnavailable({ activationUrl, canSwitchToDurableObject }) {
      note([
        'Cloudflare requires R2 to be enabled before dsh-edge can create a private bucket.',
        `Enable R2: ${activationUrl}`,
        'R2 Standard includes monthly free usage, but activation requires Dashboard checkout.',
        'After checkout completes, return here and retry.',
      ].join('\n'), 'R2 is not enabled for this account')
      const options = [
        ...(canSwitchToDurableObject
          ? [{
              value: 'temporary-do',
              label: 'Use Durable Object storage',
              hint: 'continue now without R2; 64 MiB per instance',
            }]
          : []),
        {
          value: 'retry',
          label: 'Retry R2',
          hint: 'choose this after enabling R2 in the Dashboard',
        },
        { value: 'cancel', label: 'Cancel installation' },
      ]
      return await requireAnswer(await clack.select(withOutput({
        message: 'How should dsh-edge continue?',
        initialValue: canSwitchToDurableObject ? 'temporary-do' : 'retry',
        signal,
        options,
      })))
    },
    async selectOwnerSecretMode() {
      return await requireAnswer(await clack.select(withOutput({
        message: 'Set the owner access key',
        initialValue: 'generate',
        signal,
        options: [
          { value: 'generate', label: 'Generate a secure key', hint: 'recommended' },
          { value: 'custom', label: 'Enter my own key' },
        ],
      })))
    },
    async ownerSecret(validate) {
      return await requireAnswer(await clack.password(withOutput({
        message: 'Owner access key',
        mask: '•',
        signal,
        validate,
      })))
    },
    async deepSeekKey(validate) {
      const mode = await requireAnswer(await clack.select(withOutput({
        message: 'DeepSeek API key setup',
        initialValue: 'enter',
        signal,
        options: [
          { value: 'enter', label: 'Enter now' },
          { value: 'skip', label: 'Configure later in Settings → Models', hint: 'optional' },
        ],
      })))
      if (mode === 'skip') return ''
      return await requireAnswer(await clack.password(withOutput({
        message: 'DeepSeek API key',
        mask: '•',
        signal,
        validate,
      })))
    },
    async confirm(summary) {
      note([
        `Runtime: ${summary.modeLabel}`,
        `Account: ${summary.accountLabel}`,
        `Worker: ${summary.workerName}`,
        `Cost: ${summary.paid ? 'Workers Paid is required' : 'Works on Workers Free'}`,
        `Images: ${summary.attachmentStorage === 'temporary-do'
          ? 'stored in this instance (64 MiB limit)'
          : 'stored privately in Cloudflare R2'}`,
        ...(command === 'upgrade' ? ['Existing Durable Object data is preserved.', 'You will re-enter the two Worker secrets after confirming.'] : []),
      ].join('\n'), command === 'upgrade' ? 'Upgrade summary' : 'Installation summary')
      return await requireAnswer(await clack.confirm(withOutput({
        message: command === 'upgrade' ? 'Upgrade this instance?' : 'Install this instance?',
        initialValue: true,
        signal,
      })))
    },
    async acceptTemporaryTerms() {
      note([
        'Cloudflare Terms of Service: https://www.cloudflare.com/terms/',
        'Cloudflare Privacy Policy: https://www.cloudflare.com/privacypolicy/',
      ].join('\n'), 'Temporary account terms')
      return await requireAnswer(await clack.confirm(withOutput({
        message: 'Accept these terms and create a temporary Cloudflare account?',
        initialValue: false,
        signal,
      })))
    },
    deploymentStart(message) {
      deploymentSpinner = clack.spinner(withOutput({ indicator: 'timer', signal }))
      deploymentSpinner.start(message)
    },
    deploymentFinish(succeeded) {
      if (deploymentSpinner === undefined) return
      if (succeeded) deploymentSpinner.stop('Cloudflare accepted the Worker upload.')
      else deploymentSpinner.error('Cloudflare did not accept the Worker upload.')
      deploymentSpinner = undefined
    },
    activationStart(message) {
      activationSpinner = clack.spinner(withOutput({ indicator: 'timer', signal }))
      activationSpinner.start(message)
    },
    activationFinish(result) {
      if (activationSpinner === undefined) return
      if (result?.status === 'ready') activationSpinner.stop('Public URL is ready.')
      else if (result?.status === 'pending') {
        activationSpinner.stop('Worker uploaded; public URL activation is still pending.')
      } else {
        activationSpinner.stop('Stopped waiting for public URL activation.')
      }
      activationSpinner = undefined
    },
    failedDeployment(result) {
      note([
        `Worker: ${result.workerName}`,
        'Status: the Worker was not installed.',
        `Temporary account claim URL: ${result.claimUrl}`,
        '',
        'You may claim the temporary account within 60 minutes, then retry the installation.',
      ].join('\n'), 'Installation did not complete')
    },
    cleanupFailure(message) {
      log(clack.log.warn, message)
    },
    recovery(result) {
      note(recoveryLines(result).join('\n'), 'Worker uploaded — recovery details')
    },
    outputFailureRecovery(result, failedStream) {
      const lines = [
        '',
        'Worker uploaded — recovery details',
        ...recoveryLines(result),
        '',
      ]
      if (writeRecovery !== undefined) {
        return writeRecovery(failedStream, lines.join('\n'))
      }
      return writeAlternate(writeDescriptor, failedStream, lines)
    },
    success(result) {
      const lines = [
        ...(result.activation?.status === 'ready'
          ? ['Status: Ready']
          : [
              'Status: Cloudflare is still activating the public URL.',
              'First-time workers.dev activation can take about a minute.',
              'If the URL shows a placeholder, wait a moment and refresh.',
            ]),
        '',
        `URL: ${result.publicUrl}`,
        `Owner access key: ${result.ownerSecret}`,
      ]
      if (result.claimUrl !== undefined) {
        lines.push(
          `Claim URL: ${result.claimUrl}`,
          '',
          'Next steps:',
          '1. Claim this temporary account within 60 minutes to keep the Worker and its data.',
          '2. Open the URL above.',
          '3. Enter the owner access key when prompted.',
          '4. Save the owner access key for future upgrades.',
        )
      } else {
        lines.push(
          '',
          'Next steps:',
          '1. Open the URL above.',
          '2. Enter the owner access key when prompted.',
          '3. Save the owner access key for future upgrades.',
        )
      }
      const ready = result.activation?.status === 'ready'
      const title = ready
        ? (command === 'upgrade' ? 'dsh-edge upgrade is live' : 'dsh-edge is ready')
        : 'Worker uploaded — activation pending'
      note(lines.join('\n'), title)
      const outro = ready
        ? (command === 'upgrade' ? 'Your dsh-edge upgrade is live.' : 'Your dsh-edge is ready.')
        : `${command === 'upgrade' ? 'Upgrade' : 'Installation'} succeeded; Cloudflare is still activating the public URL.`
      log(clack.outro, outro)
    },
  }
}

function recoveryLines(result) {
  const lines = [
    `Worker: ${result.workerName}`,
    `Active owner access key: ${result.ownerSecret}`,
  ]
  if (result.publicUrl !== undefined) lines.unshift(`URL: ${result.publicUrl}`)
  if (result.claimUrl !== undefined) lines.push(`Claim URL: ${result.claimUrl}`)
  lines.push('Save this key. Wrangler reported a successful upload, but the installer could not complete its handoff.')
  return lines
}

function writeAlternate(writeDescriptor, failedStream, lines) {
  const descriptor = failedStream === 'stdout' ? 2 : 1
  try {
    writeDescriptor(descriptor, lines.join('\n'))
    return true
  } catch {
    // The alternate process stream is unavailable too; credential cleanup must continue.
    return false
  }
}

function requireAnswer(value) {
  if (prompt.isCancel(value)) throw new InstallCancelledError()
  return value
}

export async function runInstaller({
  command = 'install',
  verbose = false,
  install,
  installEdgeImpl = installEdge,
  installerUi,
  outputDrainTimeoutMs = OUTPUT_DRAIN_TIMEOUT_MS,
  uiFactory = (signal, output, writeRecovery) => createInstallerUi(
    prompt,
    signal,
    writeSync,
    output,
    writeRecovery,
    command,
  ),
  runtimeProcess = process,
  stderr = process.stderr,
  stdout = process.stdout,
  wranglerRunner = executeWrangler,
} = {}) {
  const controller = new AbortController()
  let interruption
  let outputFailure
  let notifyOutputFailure
  const outputFailureDetected = new Promise(resolve => {
    notifyOutputFailure = resolve
  })
  let recoveryStream
  const failOutput = (stream, error) => {
    if (outputFailure !== undefined) return
    outputFailure = new InstallerOutputError(stream, error)
    recoveryStream ??= stream
    notifyOutputFailure()
    controller.abort(outputFailure)
  }
  const stdoutBoundary = createInstallerOutput(stdout, error => failOutput('stdout', error))
  const stderrBoundary = createInstallerOutput(stderr, error => failOutput('stderr', error))
  const cancelBlockedOutput = () => {
    const interruptError = interruption ?? controller.signal.reason
    if (!(interruptError instanceof InstallInterruptedError)) return
    const stdoutBlocked = stdoutBoundary.cancel()
    const stderrBlocked = stderrBoundary.cancel()
    recoveryStream ??= stderrBlocked && !stdoutBlocked ? 'stderr' : 'stdout'
    interruptError.outputFailureStream = recoveryStream
  }
  controller.signal.addEventListener('abort', cancelBlockedOutput)
  const installOperation = install ?? (options => installEdgeImpl({
    ...options,
    observeActivation: observePublicActivation,
    runWrangler: (args, runOptions) => wranglerRunner(args, {
      ...runOptions,
      forwardOutput: verbose || (runOptions?.forwardOutput ?? runOptions?.interactive ?? false),
      stderrDestination: stderrBoundary.output,
      stdoutDestination: stdoutBoundary.output,
    }),
  }))
  const writeRecovery = (failedStream, value) => {
    const alternateBoundary = failedStream === 'stdout' ? stderrBoundary : stdoutBoundary
    return alternateBoundary.write(value)
  }
  const baseUi = installerUi
    ?? uiFactory(controller.signal, stdoutBoundary.output, writeRecovery)
  let lastRecovery
  let alternateRecoveryAttempted = false
  let alternateRecoveryPending
  const deliverAlternateRecovery = (result, stream) => {
    if (alternateRecoveryAttempted) return
    alternateRecoveryAttempted = true
    try {
      alternateRecoveryPending = Promise.resolve(baseUi.outputFailureRecovery(result, stream))
        .then(delivered => delivered !== false, () => false)
    } catch {
      alternateRecoveryPending = Promise.resolve()
    }
  }
  const ui = {
    ...baseUi,
    recovery(result) {
      lastRecovery = result
      if (recoveryStream === undefined) baseUi.recovery(result)
      else deliverAlternateRecovery(result, recoveryStream)
    },
    outputFailureRecovery(result, stream) {
      lastRecovery = result
      recoveryStream ??= stream
      deliverAlternateRecovery(result, stream)
    },
    success(result) {
      lastRecovery = result
      if (recoveryStream === undefined) baseUi.success(result)
      else deliverAlternateRecovery(result, recoveryStream)
    },
  }
  const handlers = new Map([...INTERRUPT_EXIT_CODES].map(([signal]) => [
    signal,
    () => {
      interruption ??= new InstallInterruptedError(signal)
      if (controller.signal.aborted) cancelBlockedOutput()
      else controller.abort(interruption)
    },
  ]))
  for (const [signal, handler] of handlers) runtimeProcess.on(signal, handler)
  let result
  let installError
  try {
    try {
      result = await installOperation({ command, ui, signal: controller.signal })
    } catch (error) {
      installError = error
    }
    if (outputFailure === undefined) {
      await Promise.race([
        Promise.all([stdoutBoundary.settled(), stderrBoundary.settled()]),
        outputFailureDetected,
      ])
    }
    if (recoveryStream !== undefined && lastRecovery !== undefined) {
      deliverAlternateRecovery(lastRecovery, recoveryStream)
    }
    const outputsSettled = Promise.all([stdoutBoundary.settled(), stderrBoundary.settled()])
    if (outputFailure !== undefined) {
      let timeout
      const drainTimedOut = new Promise(resolve => {
        timeout = setTimeout(() => resolve(true), outputDrainTimeoutMs)
      })
      try {
        const timedOut = await Promise.race([
          outputsSettled.then(() => false),
          drainTimedOut,
        ])
        if (timedOut) {
          stdoutBoundary.cancel()
          stderrBoundary.cancel()
          await outputsSettled
        }
      } finally {
        clearTimeout(timeout)
      }
    } else {
      await outputsSettled
    }
    await alternateRecoveryPending
    const abortError = interruption ?? controller.signal.reason
    if (abortError instanceof InstallInterruptedError) throw abortError
    if (outputFailure !== undefined && abortError === outputFailure) throw outputFailure
    if (installError !== undefined) throw installError
    if (abortError instanceof Error) throw abortError
    if (controller.signal.aborted) throw new Error('Installation aborted without an Error reason.')
    return result
  } finally {
    for (const [signal, handler] of handlers) runtimeProcess.removeListener(signal, handler)
    controller.signal.removeEventListener('abort', cancelBlockedOutput)
    stdoutBoundary.dispose()
    stderrBoundary.dispose()
  }
}

function createInstallerOutput(destination, onFailure) {
  let activeWrite
  let failed = false
  let pendingWrites = 0
  const settleWaiters = new Set()
  const settle = () => {
    if (pendingWrites !== 0 || output.writableLength !== 0) return
    for (const resolve of settleWaiters) resolve()
    settleWaiters.clear()
  }
  const fail = (error) => {
    if (failed) return
    failed = true
    onFailure(error instanceof Error ? error : new Error(String(error)))
    activeWrite?.()
  }
  const closed = () => fail(new Error('Output destination closed during installation.'))
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (failed) {
        callback()
        queueMicrotask(settle)
        return
      }
      pendingWrites += 1
      let completed = false
      const written = (error) => {
        if (completed) return
        completed = true
        activeWrite = undefined
        if (error !== undefined && error !== null) fail(error)
        pendingWrites = Math.max(0, pendingWrites - 1)
        callback()
        queueMicrotask(settle)
      }
      activeWrite = written
      try {
        destination.write(chunk, encoding, written)
      } catch (error) {
        written(error)
      }
    },
  })
  Object.defineProperties(output, {
    columns: { get: () => destination.columns },
    isTTY: { get: () => destination.isTTY },
    rows: { get: () => destination.rows },
  })
  destination.on('error', fail)
  destination.on('close', closed)
  return {
    output,
    write(value) {
      return new Promise(resolve => {
        if (failed) {
          resolve(false)
          return
        }
        output.write(value, () => resolve(!failed))
      })
    },
    cancel() {
      const blocked = pendingWrites !== 0 || output.writableLength !== 0
      if (!blocked) return false
      failed = true
      destination.destroy()
      activeWrite?.()
      return true
    },
    settled() {
      if (pendingWrites === 0 && output.writableLength === 0) return Promise.resolve()
      return new Promise(resolve => settleWaiters.add(resolve))
    },
    dispose() {
      destination.removeListener('error', fail)
      destination.removeListener('close', closed)
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const command = parseCommand(args)
  if (command === 'help') {
    process.stdout.write('Usage: dsh-edge <install|upgrade> [--verbose]\n\nCommands:\n  install   Create or update an instance\n  upgrade   Upgrade an existing instance without deleting its data\n\nOptions:\n  --verbose  Show Wrangler deployment output\n')
    return
  }
  if (command === 'version') {
    process.stdout.write(`${edgePackage.version}\n`)
    return
  }
  await runInstaller({ command, verbose: args.includes('--verbose') })
}

function usageError() {
  return new Error('Usage: dsh-edge <install|upgrade> [--verbose]')
}

if (process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    if (error instanceof InstallCancelledError) {
      if (error instanceof InstallInterruptedError) {
        writeAlternate(
          writeSync,
          error.outputFailureStream ?? 'stdout',
          ['', `Installation interrupted by ${error.signal}.`, ''],
        )
        process.exitCode = error.exitCode
      } else {
        prompt.cancel(error.message)
      }
      return
    }
    if (error instanceof InstallerOutputError) {
      writeAlternate(writeSync, error.stream, ['', `Installation failed: ${error.message}`, ''])
      process.exitCode = 1
      return
    }
    prompt.cancel(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
