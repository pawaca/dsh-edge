#!/usr/bin/env node

import * as prompt from '@clack/prompts'
import { spawn } from 'node:child_process'
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
import { modeCapabilities, RUNTIME_MODES, runtimeModeChoices } from './runtime-providers.mjs'

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
const KEPT_ON_UPDATE = 'conversations, files, access key, and DeepSeek key'
const CONTAINER_ROLLOUT_NOTE = 'The first command after this can take a few minutes while the container image rolls out.'
const SESSION_FORMAT_UPGRADE_NOTE = 'Stored sessions move to a new format when this release first starts; only the stored rows that change are rewritten. Rolling back to an earlier dsh-edge release afterwards is not supported.'

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

/** The platform command that opens `url` in the default browser. */
export function browserOpenCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url] }
}

/** Open `url` in the default browser; resolves whether the opener started. */
export function openInBrowser(url) {
  const { command, args } = browserOpenCommand(url)
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

export function createInstallerUi(
  clack = prompt,
  signal,
  writeDescriptor = writeSync,
  output,
  writeRecovery,
  command = 'install',
  openUrl = openInBrowser,
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
    async existingWorker({ workerName, mode, sessionFormatUpgrade }) {
      note([
        ...fields([
          ['Can', modeCapabilities(mode).join(', ')],
          ['After', `dsh-edge ${edgePackage.version} with the same capabilities`],
          ['Kept', KEPT_ON_UPDATE],
        ]),
        ...(mode === 'container' ? [CONTAINER_ROLLOUT_NOTE] : []),
        ...(sessionFormatUpgrade ? [SESSION_FORMAT_UPGRADE_NOTE] : []),
      ].join('\n'), `${workerName} already exists`)
      return await requireAnswer(await clack.select(withOutput({
        message: `Update ${workerName}?`,
        initialValue: 'update',
        signal,
        options: [
          { value: 'update', label: 'Update it', hint: 'keeps everything' },
          { value: 'change', label: 'Update and change what it can do' },
          { value: 'rename', label: 'Use another name' },
          { value: 'cancel', label: 'Cancel' },
        ],
      })))
    },
    async nameTaken(workerName) {
      return await requireAnswer(await clack.select(withOutput({
        message: `${workerName} is already used by a Worker that is not dsh-edge`,
        initialValue: 'rename',
        signal,
        options: [
          { value: 'rename', label: 'Use another name' },
          { value: 'cancel', label: 'Cancel' },
        ],
      })))
    },
    async selectCapability(current) {
      return await requireAnswer(await clack.select(withOutput({
        message: 'What should your agent be able to do?',
        initialValue: current ?? 'direct',
        signal,
        options: runtimeModeChoices().map(choice => choice.value === current
          ? { ...choice, hint: `${choice.hint} · current` }
          : choice),
      })))
    },
    async confirmDowngrade(lost) {
      note([
        `This removes: ${lost.join(', ')}.`,
        'Conversations and files are kept.',
      ].join('\n'), 'Fewer capabilities')
      return await requireAnswer(await clack.confirm(withOutput({
        message: 'Continue with fewer capabilities?',
        initialValue: false,
        signal,
      })))
    },
    async r2SubscriptionUnavailable({ activationUrl }) {
      note([
        'This Worker stores its images in Cloudflare R2, which is not enabled for this account.',
        `Enable R2: ${activationUrl}`,
        'R2 Standard includes monthly free usage, but activation requires Dashboard checkout.',
        'After checkout completes, return here and retry.',
      ].join('\n'), 'R2 is not enabled for this account')
      return await requireAnswer(await clack.select(withOutput({
        message: 'How should dsh-edge continue?',
        initialValue: 'retry',
        signal,
        options: [
          { value: 'retry', label: 'Retry R2', hint: 'choose this after enabling R2 in the Dashboard' },
          { value: 'cancel', label: 'Cancel installation' },
        ],
      })))
    },
    async confirm(summary) {
      note([
        ...fields([
          ['Can', modeCapabilities(summary.mode).join(', ')],
          ['Cost', RUNTIME_MODES[summary.mode].cost],
          ['Account', summary.accountLabel],
          ['Worker', summary.workerName],
          ['Images', summary.attachmentStorage === 'temporary-do'
            ? 'stored in this instance (64 MiB limit)'
            : 'stored privately in Cloudflare R2'],
          ...(summary.updating
            ? [['Kept', KEPT_ON_UPDATE]]
            : [
                ['Owner key', 'generated and shown when installation finishes'],
                ['DeepSeek', 'add your API key when the web app asks, or later in Settings → Models'],
              ]),
        ]),
        ...(summary.mode === 'container'
          ? ['', 'The container sleeps after 10 idle minutes by default; change it in Settings → DSH Edge.', CONTAINER_ROLLOUT_NOTE]
          : []),
        ...(summary.temporary
          ? [
              '',
              'The temporary account lasts 60 minutes unless you claim it.',
              'Installing accepts the Cloudflare Terms of Service (https://www.cloudflare.com/terms/)',
              'and Privacy Policy (https://www.cloudflare.com/privacypolicy/).',
            ]
          : []),
      ].join('\n'), summary.updating ? `Update ${summary.workerName}` : `Install ${summary.workerName}`)
      return await requireAnswer(await clack.confirm(withOutput({
        message: summary.temporary
          ? 'Accept the terms and install?'
          : summary.updating ? 'Update this instance?' : 'Install this instance?',
        initialValue: true,
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
      if (result?.status === 'ready') activationSpinner.stop('Chat and workspace services are ready.')
      else if (result?.status === 'live') activationSpinner.stop('The new release is live.')
      else if (result?.status === 'pending') {
        activationSpinner.stop('Worker uploaded; application readiness is not yet verified.')
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
    async success(result) {
      const status = result.activation?.status
      const newKey = result.ownerSecret !== undefined
      const steps = [
        ...(result.claimUrl === undefined
          ? []
          : ['Claim this temporary account within 60 minutes to keep the Worker and its data.']),
        'Open the URL above.',
        newKey
          ? 'Enter the owner access key when prompted.'
          : 'Sign in with your existing owner access key.',
        ...(result.updated ? [] : ['Add your DeepSeek API key when the web app asks (or later in Settings → Models).']),
        ...(newKey ? ['Save the owner access key; you need it to sign in.'] : []),
      ]
      note([
        ...(status === 'ready'
          ? ['Status: Ready']
          : status === 'live'
            ? ['Status: Live — the new release is serving.',
                'Sign in to confirm your chats and workspaces load.']
            : [
                'Status: Application readiness has not been verified.',
                'The public URL or application may still be starting.',
                'Open the URL and confirm your chats and workspaces load before using it.',
              ]),
        '',
        `URL: ${result.publicUrl}`,
        `Owner access key: ${newKey ? result.ownerSecret : 'unchanged'}`,
        ...(result.claimUrl === undefined ? [] : [`Claim URL: ${result.claimUrl}`]),
        '',
        'Next steps:',
        ...steps.map((step, index) => `${index + 1}. ${step}`),
      ].join('\n'), status === 'ready' || status === 'live'
        ? (result.updated ? 'dsh-edge update is live' : 'dsh-edge is ready')
        : 'Worker uploaded — readiness unverified')
      // The instance is already deployed, so declining or cancelling only skips the browser.
      if (terminal.isTTY === true && await clack.confirm(withOutput({
        message: 'Open dsh-edge in your browser?',
        initialValue: true,
        signal,
      })) === true && !await openUrl(result.publicUrl)) {
        log(clack.log.warn, 'Could not open a browser. Open the URL above.')
      }
      log(clack.outro, status === 'ready' || status === 'live'
        ? (result.updated ? 'Your dsh-edge update is live.' : 'Your dsh-edge is ready.')
        : 'Worker uploaded; application readiness remains unverified.')
    },
  }
}

/** Align `label: value` rows into one column. */
function fields(rows) {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2
  return rows.map(([label, value]) => `${label}:`.padEnd(width) + value)
}

function recoveryLines(result) {
  const lines = [
    `Worker: ${result.workerName}`,
    result.ownerSecret === undefined
      ? 'Owner access key: unchanged'
      : `Active owner access key: ${result.ownerSecret}`,
  ]
  if (result.publicUrl !== undefined) lines.unshift(`URL: ${result.publicUrl}`)
  if (result.claimUrl !== undefined) lines.push(`Claim URL: ${result.claimUrl}`)
  lines.push(`${result.ownerSecret === undefined ? '' : 'Save this key. '}Wrangler reported a successful upload, but the installer could not complete its handoff.`)
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
    async success(result) {
      lastRecovery = result
      if (recoveryStream === undefined) await baseUi.success(result)
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
    process.stdout.write('Usage: dsh-edge <install|upgrade> [--verbose]\n\nCommands:\n  install   Create an instance, or update one that already exists\n  upgrade   Update an existing instance, keeping its data and keys\n\nOptions:\n  --verbose  Show Wrangler deployment output\n\nEnvironment:\n  DSH_EDGE_ACCESS_KEY  Owner access key for a new instance (default: generated)\n')
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
