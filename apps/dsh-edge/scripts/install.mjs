import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { writePrebuiltModeWranglerConfig } from './wrangler-config.mjs'

export const DEFAULT_WORKER_NAME = 'dsh-edge'
export const LOGIN_PROFILE = 'dsh-edge-install'
export const RUNTIME_MODES = Object.freeze({
  direct: Object.freeze({
    environment: '',
    expectedShell: 'just-bash-direct',
    label: 'Free — Direct Shell',
  }),
  isolated: Object.freeze({
    environment: 'isolated',
    expectedShell: 'just-bash-isolated',
    label: 'Isolated — Dynamic Worker',
  }),
})

const appDirectory = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const WRANGLER_CLI = require.resolve('wrangler')
const AUTH_ENV_KEYS = Object.freeze([
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_EMAIL',
  'CF_ACCOUNT_ID',
  'CF_API_KEY',
  'CF_API_TOKEN',
  'CF_EMAIL',
])
const CLOUDFLARE_CONTEXT_ENV_KEYS = Object.freeze([
  'CLOUDFLARE_API_BASE_URL',
  'CLOUDFLARE_CONFIG_PATH',
  'WRANGLER_HOME',
])
const RUNTIME_ENV_KEYS = Object.freeze([
  'ALL_PROXY',
  'APPDATA',
  'CI',
  'COLORTERM',
  'COMSPEC',
  'ComSpec',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'FORCE_COLOR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LANGUAGE',
  'LOCALAPPDATA',
  'NO_COLOR',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'PATH',
  'Path',
  'PATHEXT',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
])
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const SENSITIVE_ENV_KEY = /(KEY|PASSWORD|SECRET|TOKEN)/iu
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const CLAIM_URL = /https:\/\/dash\.cloudflare\.com\/claim-preview\?[^\s\u001b]+/u
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
const WINDOWS_ACL_TIMEOUT_MS = 30_000
const WINDOWS_PRIVATE_DIRECTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$directory = [System.IO.Path]::GetFullPath($env:DSH_EDGE_PRIVATE_DIRECTORY)
if (-not [System.IO.Directory]::Exists($directory)) {
  throw 'Installer temporary directory does not exist.'
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($directory, $acl)

$verified = [System.IO.Directory]::GetAccessControl(
  $directory,
  [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
)
$owner = $verified.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $verified.AreAccessRulesProtected -or $owner.Value -ne $identity.Value -or $rules.Count -ne 1) {
  throw "Installer temporary directory DACL is not private (protected=$($verified.AreAccessRulesProtected), owner=$($owner.Value), user=$($identity.Value), rules=$($rules.Count))."
}
$verifiedRule = $rules[0]
if (
  $verifiedRule.IdentityReference.Value -ne $identity.Value -or
  $verifiedRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  $verifiedRule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
  $verifiedRule.InheritanceFlags -ne $inheritance -or
  $verifiedRule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None
) {
  throw 'Installer temporary directory DACL has unexpected access rules.'
}
`

export class InstallCancelledError extends Error {
  constructor() {
    super('Installation cancelled.')
    this.name = 'InstallCancelledError'
  }
}

export class InstallerOutputError extends Error {
  constructor(stream, cause) {
    super(`Could not write installer ${stream}: ${describeError(cause)}`, { cause })
    this.name = 'InstallerOutputError'
    this.stream = stream
  }
}

/** Return account choices permitted by the selected runtime. */
export function accountChoices(mode, accounts, command = 'install') {
  requireRuntimeMode(mode)
  const choices = []
  if (mode === 'direct' && command === 'install') {
    choices.push({
      value: 'temporary',
      label: 'Temporary account — no Cloudflare login',
      hint: 'available for 60 minutes; claim it to keep the instance',
    })
  }
  for (const account of accounts) {
    choices.push({
      value: `account:${account.id}`,
      label: account.name,
      hint: `Cloudflare account ${account.id}`,
    })
  }
  choices.push({
    value: 'login',
    label: 'Sign in or create a Cloudflare account',
    hint: 'opens Cloudflare in your browser',
  })
  return choices
}

/** Parse the stable subset of `wrangler whoami --json`. */
export function parseWhoami(source) {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('Wrangler returned invalid account information.')
  }
  if (value === null || typeof value !== 'object' || value.loggedIn !== true
    || !Array.isArray(value.accounts)) {
    throw new Error('Wrangler did not return an authenticated Cloudflare account.')
  }
  const accounts = value.accounts.map((account) => {
    if (account === null || typeof account !== 'object'
      || typeof account.id !== 'string' || account.id.trim() === ''
      || !isTerminalSafe(account.id)
      || typeof account.name !== 'string' || account.name.trim() === ''
      || !isTerminalSafe(account.name)) {
      throw new Error('Wrangler returned malformed Cloudflare account information.')
    }
    return { id: account.id, name: account.name }
  })
  if (typeof value.email === 'string' && !isTerminalSafe(value.email)) {
    throw new Error('Wrangler returned malformed Cloudflare account information.')
  }
  return { accounts, email: typeof value.email === 'string' ? value.email : undefined }
}

/** Validate the exact Workers service-name format accepted by Wrangler. */
export function validateWorkerName(value) {
  if (!WORKER_NAME.test(value)) {
    return 'Use 1–63 lowercase letters, numbers, or dashes; start and end with a letter or number.'
  }
}

/** Validate the login secret against the runtime's byte-level contract. */
export function validateOwnerSecret(value) {
  if (value !== value.trim()) return 'The access key cannot start or end with whitespace.'
  if (CONTROL_CHARACTER.test(value)) return 'The access key cannot contain control characters.'
  if (BIDI_CONTROL.test(value)) return 'The access key cannot contain bidirectional controls.'
  const length = Buffer.byteLength(value, 'utf8')
  if (length < 32 || length > 512) return 'The access key must be 32–512 UTF-8 bytes.'
}

/** Validate a provider key without encoding assumptions that DeepSeek does not promise. */
export function validateDeepSeekKey(value) {
  if (value === '') return 'Enter a DeepSeek API key.'
  if (value !== value.trim()) return 'The DeepSeek API key cannot start or end with whitespace.'
  if (CONTROL_CHARACTER.test(value)) return 'The DeepSeek API key cannot contain control characters.'
}

export function generateOwnerSecret() {
  return randomBytes(32).toString('base64url')
}

/** Build the least-privilege environment used by authenticated Wrangler commands. */
export function wranglerEnvironment(environment = process.env) {
  return pickEnvironment(environment, [
    ...RUNTIME_ENV_KEYS,
    ...CLOUDFLARE_CONTEXT_ENV_KEYS,
    ...AUTH_ENV_KEYS,
  ])
}

/** Build a Wrangler runtime environment without any Cloudflare authentication source. */
export function unauthenticatedEnvironment(environment = process.env) {
  return pickEnvironment(environment, RUNTIME_ENV_KEYS)
}

/** Build an exact, secret-free Wrangler deployment command. */
export function wranglerDeployArgs({
  mode,
  workerName,
  secretsFile,
  configFile,
  profile,
  temporary = false,
}) {
  requireRuntimeMode(mode)
  if (temporary && mode !== 'direct') {
    throw new Error('Temporary accounts support only the Free direct runtime.')
  }
  const args = [
    'deploy',
    '--env',
    RUNTIME_MODES[mode].environment,
    '--name',
    workerName,
    '--config',
    configFile,
    '--secrets-file',
    secretsFile,
  ]
  if (temporary) args.push('--temporary')
  if (profile !== undefined) args.push('--profile', profile)
  return args
}

/** Parse the structured Wrangler deploy event and require a public HTTPS target. */
export function parseDeploymentOutput(source) {
  const events = source.split(/\r?\n/u).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error('Wrangler wrote malformed deployment metadata.')
    }
  })
  const deploy = events.findLast(event => event?.type === 'deploy' && event?.version === 1)
  if (deploy === undefined || !Array.isArray(deploy.targets)) {
    throw new Error('Wrangler did not report a deployed Worker target.')
  }
  for (const target of deploy.targets) {
    if (typeof target !== 'string') continue
    const candidate = target.startsWith('https://') ? target : `https://${target}`
    try {
      const url = new URL(candidate)
      if (url.protocol === 'https:' && url.username === '' && url.password === ''
        && url.hostname.endsWith('.workers.dev')
        && url.pathname === '/' && url.search === '' && url.hash === '') {
        return { publicUrl: url.origin, versionId: deploy.version_id }
      }
    } catch {
      // A route description is not necessarily a public URL; try the next target.
    }
  }
  throw new Error('Wrangler did not report a public workers.dev URL for the Worker.')
}

export function parseClaimUrl(source) {
  const match = CLAIM_URL.exec(source)
  if (match === null) return undefined
  const claimUrl = match[0].replace(/[),.;]+$/u, '')
  return isTerminalSafe(claimUrl) ? claimUrl : undefined
}

/** Distinguish an absent Worker from account and transport failures. */
export function parseWorkerExistence(result) {
  if (result.status === 0) return true
  if (/\[code:\s*10007\]/u.test(`${result.stdout}\n${result.stderr}`)) return false
  throw new Error(commandFailure('Could not check whether the Worker already exists', result))
}

/** Run the complete guided install with UI and Wrangler supplied as replaceable boundaries. */
export async function installEdge({
  command = 'install',
  ui,
  runWrangler = executeWrangler,
  environment = process.env,
  createTemporaryDirectory = createPrivateTemporaryDirectory,
  removePath = rm,
  signal,
} = {}) {
  if (ui === undefined) throw new Error('installEdge requires an installer UI.')
  signal?.throwIfAborted()
  let temporaryDirectory
  let completedResult
  let primaryError
  if (command !== 'install' && command !== 'upgrade') throw new Error(`Unknown installer command: ${command}`)
  ui.intro(`dsh-edge ${command}`)
  try {
    const mode = await ui.selectRuntime()
    requireRuntimeMode(mode)

    ui.step('Checking Cloudflare accounts…')
    const detected = await detectAccounts({ runWrangler, environment, signal })
    let accountSelection = await ui.selectAccount(accountChoices(mode, detected.accounts, command))
    let profile
    let profileEnvironment
    let accounts = detected.accounts
    if (accountSelection === 'login') {
      ui.step('Opening Cloudflare sign-in…')
      profileEnvironment = unauthenticatedEnvironment(environment)
      const auth = await runWrangler(['auth', 'create', LOGIN_PROFILE], {
        environment: profileEnvironment,
        interactive: true,
        signal,
      })
      requireSuccess(auth, 'Cloudflare sign-in failed')
      profile = LOGIN_PROFILE
      const signedIn = await requireAccounts({
        runWrangler,
        environment: profileEnvironment,
        profile,
        signal,
      })
      accounts = signedIn.accounts
      accountSelection = await ui.selectAccount(accountChoices(mode, accounts, command)
        .filter(choice => choice.value.startsWith('account:')))
    }

    const temporary = accountSelection === 'temporary'
    if (temporary && command === 'upgrade') {
      throw new Error('Temporary accounts cannot be upgraded before they are claimed.')
    }
    if (temporary && mode !== 'direct') {
      throw new Error('Temporary accounts support only the Free direct runtime.')
    }
    const account = temporary
      ? undefined
      : requireSelectedAccount(accountSelection, accounts)

    let workerName = DEFAULT_WORKER_NAME
    while (true) {
      workerName = await ui.workerName(workerName, validateWorkerName)
      if (temporary) break
      ui.step(`Checking ${workerName}…`)
      const exists = parseWorkerExistence(await runWrangler([
        'deployments', 'list', '--name', workerName, '--json',
        ...runtimeEnvironmentArgs(mode),
        ...profileArgs(profile),
      ], {
        environment: accountEnvironment(profileEnvironment ?? environment, account.id),
        signal,
      }))
      if (command === 'upgrade') {
        if (!exists) throw new Error(`${workerName} does not exist in this account and runtime. Run dsh-edge install first.`)
        break
      }
      if (!exists) break
      const action = await ui.workerConflict(workerName)
      if (action === 'update') break
      if (action === 'cancel') throw new InstallCancelledError()
      workerName = `${workerName}-2`
    }

    const secretMode = await ui.selectOwnerSecretMode()
    const ownerSecret = secretMode === 'generate'
      ? generateOwnerSecret()
      : await ui.ownerSecret(validateOwnerSecret)
    const secretError = validateOwnerSecret(ownerSecret)
    if (secretError !== undefined) throw new Error(secretError)
    const deepSeekKey = await ui.deepSeekKey(validateDeepSeekKey)
    const deepSeekError = validateDeepSeekKey(deepSeekKey)
    if (deepSeekError !== undefined) throw new Error(deepSeekError)

    const confirmed = await ui.confirm({
      mode,
      modeLabel: RUNTIME_MODES[mode].label,
      accountLabel: temporary ? 'Temporary account' : account.name,
      workerName,
      paid: mode === 'isolated',
    })
    if (!confirmed) throw new InstallCancelledError()
    if (temporary && !await ui.acceptTemporaryTerms()) {
      throw new InstallCancelledError()
    }

    temporaryDirectory = await createTemporaryDirectory()
    const secretsFile = join(temporaryDirectory, 'secrets.json')
    const configFile = join(temporaryDirectory, 'wrangler.json')
    const outputFile = join(temporaryDirectory, 'wrangler-output.ndjson')
    await writePrebuiltModeWranglerConfig(mode, configFile)
    await writeFile(secretsFile, JSON.stringify({
      DEEPSEEK_API_KEY: deepSeekKey,
      DSH_EDGE_ACCESS_KEY: ownerSecret,
    }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })

    const deploymentMessage = command === 'upgrade'
      ? 'Uploading the tested Worker release…'
      : 'Installing the tested Worker release…'
    ui.deploymentStart?.(deploymentMessage)
    const commandEnvironment = temporary
      ? unauthenticatedEnvironment(environment)
      : accountEnvironment(profileEnvironment ?? environment, account.id)
    if (temporary) commandEnvironment.XDG_CONFIG_HOME = temporaryDirectory
    commandEnvironment.WRANGLER_LOG_SANITIZE = 'true'
    commandEnvironment.WRANGLER_OUTPUT_FILE_PATH = outputFile
    commandEnvironment.FORCE_COLOR = '0'
    let deployResult
    let deploySucceeded = false
    let credentialCleanupError
    try {
      deployResult = await runWrangler(wranglerDeployArgs({
        mode,
        workerName,
        secretsFile,
        configFile,
        profile: temporary ? undefined : profile,
        temporary,
      }), {
        environment: commandEnvironment,
        interactive: true,
        forwardOutput: false,
        capture: true,
        signal,
      })
      deploySucceeded = deployResult.status === 0
    } finally {
      ui.deploymentFinish?.(deploySucceeded)
      try {
        await removePath(secretsFile, { force: true })
      } catch (error) {
        credentialCleanupError = error
      }
    }
    const claimUrl = temporary
      ? parseClaimUrl(`${deployResult.stdout}\n${deployResult.stderr}`)
      : undefined
    if (deployResult.status !== 0) {
      if (claimUrl !== undefined) ui.failedDeployment?.({ claimUrl, workerName })
      const cleanupDetail = credentialCleanupError === undefined
        ? ''
        : `\nTemporary credential cleanup also failed: ${describeError(credentialCleanupError)}`
      throw new Error(`${formatDeployFailure(mode, deployResult)}${cleanupDetail}`)
    }

    const recoverUploadedWorker = () => {
      const recovery = { claimUrl, ownerSecret, workerName }
      if (deployResult.outputFailure !== undefined) {
        ui.outputFailureRecovery(recovery, deployResult.outputFailure.stream)
      } else {
        ui.recovery(recovery)
      }
    }
    if (credentialCleanupError !== undefined) {
      recoverUploadedWorker()
      throw new Error(
        `Could not remove temporary credentials: ${describeError(credentialCleanupError)}`,
        { cause: credentialCleanupError },
      )
    }
    if (deployResult.interrupted === true) {
      recoverUploadedWorker()
      throw abortReason(signal, 'Wrangler command interrupted after upload.')
    }
    if (deployResult.outputFailure !== undefined) {
      recoverUploadedWorker()
      throw deployResult.outputFailure
    }
    let deployment
    try {
      const output = await readBoundedUtf8File(outputFile, MAX_CAPTURE_BYTES)
      deployment = parseDeploymentOutput(output)
      signal?.throwIfAborted()
      if (temporary && claimUrl === undefined) {
        throw new Error('The temporary Worker was uploaded, but Wrangler did not return its claim URL.')
      }
    } catch (error) {
      ui.recovery({
        claimUrl,
        ownerSecret,
        publicUrl: deployment?.publicUrl,
        workerName,
      })
      throw error
    }
    const result = {
      ...deployment,
      account,
      claimUrl,
      mode,
      ownerSecret,
      temporary,
      workerName,
    }
    completedResult = result
  } catch (error) {
    primaryError = signal?.aborted ? abortReason(signal, 'Installation interrupted.') : error
  }

  if (primaryError === undefined && signal?.aborted) {
    primaryError = abortReason(signal, 'Installation interrupted.')
    if (completedResult !== undefined) ui.recovery(completedResult)
  }
  let directoryCleanupError
  if (temporaryDirectory !== undefined) {
    try {
      await removePath(temporaryDirectory, { recursive: true, force: true })
    } catch (error) {
      directoryCleanupError = error
    }
  }
  if (primaryError === undefined && signal?.aborted) {
    primaryError = abortReason(signal, 'Installation interrupted.')
    if (completedResult !== undefined) ui.recovery(completedResult)
  }
  if (directoryCleanupError !== undefined) {
    const message = `Could not remove private temporary files: ${describeError(directoryCleanupError)}`
    if (primaryError !== undefined) {
      ui.cleanupFailure(message)
    } else {
      if (completedResult !== undefined) ui.recovery(completedResult)
      primaryError = new Error(message, { cause: directoryCleanupError })
    }
  }
  if (primaryError !== undefined) throw primaryError
  if (completedResult === undefined) throw new Error('Installation ended without a result.')
  ui.success(completedResult)
  return completedResult
}

export function wranglerProcessInvocation(args, {
  nodeExecutable = process.execPath,
  wranglerCli = WRANGLER_CLI,
} = {}) {
  return { command: nodeExecutable, args: [wranglerCli, ...args] }
}

export async function executeWrangler(args, {
  environment = wranglerEnvironment(),
  interactive = false,
  forwardOutput = interactive,
  capture = true,
  forceKillAfterDelay = 2_000,
  invocation = wranglerProcessInvocation(args),
  signal,
  stderrDestination = process.stderr,
  stdoutDestination = process.stdout,
} = {}) {
  signal?.throwIfAborted()
  if (!Number.isFinite(forceKillAfterDelay) || forceKillAfterDelay < 0) {
    throw new Error('forceKillAfterDelay must be a non-negative finite number.')
  }
  const child = execa(invocation.command, invocation.args, {
    buffer: false,
    cleanup: true,
    cwd: appDirectory,
    env: environment,
    extendEnv: false,
    forceKillAfterDelay,
    killDescendants: true,
    reject: false,
    stderr: 'pipe',
    stdin: interactive ? 'inherit' : 'ignore',
    stdout: 'pipe',
  })
  let stdout = ''
  let stderr = ''
  let outputFailure
  let termination
  let stdoutForwarder
  let stderrForwarder
  const terminate = () => {
    termination ??= terminateProcessTree(child, forceKillAfterDelay)
  }
  const failOutput = (streamName, error) => {
    outputFailure ??= new InstallerOutputError(streamName, error)
    terminate()
    stdoutForwarder?.cancel()
    stderrForwarder?.cancel()
  }
  const stdoutTerminal = createTerminalSanitizer()
  const stderrTerminal = createTerminalSanitizer()
  stdoutForwarder = forwardOutput && child.stdout
    ? createOutputForwarder(child.stdout, stdoutDestination, error => failOutput('stdout', error))
    : undefined
  stderrForwarder = forwardOutput && child.stderr
    ? createOutputForwarder(child.stderr, stderrDestination, error => failOutput('stderr', error))
    : undefined
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    const terminalChunk = forwardOutput ? stdoutTerminal.push(chunk) : ''
    if (terminalChunk !== '') stdoutForwarder?.write(terminalChunk)
    if (capture) stdout = appendBounded(stdout, chunk)
  })
  child.stderr?.on('data', (chunk) => {
    const terminalChunk = forwardOutput ? stderrTerminal.push(chunk) : ''
    if (terminalChunk !== '') stderrForwarder?.write(terminalChunk)
    if (capture) stderr = appendBounded(stderr, chunk)
  })
  const interrupt = () => {
    terminate()
    stdoutForwarder?.cancel()
    stderrForwarder?.cancel()
  }
  signal?.addEventListener('abort', interrupt, { once: true })
  if (signal?.aborted) interrupt()
  let result
  try {
    result = await child
    await termination
    await Promise.all([
      stdoutForwarder?.settled(),
      stderrForwarder?.settled(),
    ])
    await termination
  } finally {
    signal?.removeEventListener('abort', interrupt)
    stdoutForwarder?.dispose()
    stderrForwarder?.dispose()
    await termination
  }
  const processError = result.failed && !result.isCanceled
    && result.exitCode === undefined && result.signal === undefined
    ? result
    : undefined
  return resolveWranglerClose({
    outputFailure,
    processError,
    signal,
    status: result.exitCode ?? null,
    stderr,
    stdout,
  })
}

async function terminateProcessTree(child, graceMs) {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(child, pid)
    return
  }
  signalProcessGroup(pid, 'SIGTERM', child)
  if (await waitForProcessGroupExit(pid, graceMs)) return
  signalProcessGroup(pid, 'SIGKILL', child)
  if (!await waitForProcessGroupExit(pid, Math.max(graceMs, 100))) {
    throw new Error(`Wrangler process group ${pid} did not stop after SIGKILL.`)
  }
}

function signalProcessGroup(pid, signal, child) {
  try {
    process.kill(-pid, signal)
  } catch {
    child.kill(signal)
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false
    await sleep(Math.min(15, Math.max(1, deadline - Date.now())))
  }
  return true
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function terminateWindowsProcessTree(child, pid) {
  const windowsRoot = process.env.SystemRoot ?? process.env.windir
  const taskkill = typeof windowsRoot === 'string' && /^[a-z]:[\\/]/iu.test(windowsRoot)
    ? join(windowsRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe'
  const succeeded = await new Promise(resolve => {
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      resolve(error === null)
    })
  })
  if (!succeeded) child.kill('SIGKILL')
}

/** Keep a successful child exit distinct from a concurrent abort request. */
export function resolveWranglerClose({ outputFailure, processError, signal, status, stderr, stdout }) {
  if (processError !== undefined && !isAbortProcessError(processError, signal)) {
    throw processError
  }
  if (signal?.aborted) {
    if (status === 0) {
      return {
        interrupted: true,
        ...(outputFailure === undefined ? {} : { outputFailure }),
        status,
        stderr,
        stdout,
      }
    }
    throw abortReason(signal, 'Wrangler command interrupted.')
  }
  if (outputFailure !== undefined) {
    if (status === 0) return { outputFailure, status, stderr, stdout }
    throw outputFailure
  }
  return { status, stderr, stdout }
}

/** Forward a child stream with backpressure and a recoverable destination-failure boundary. */
export function createOutputForwarder(source, destination, onFailure) {
  let failed = false
  let pendingWrites = 0
  let waitingForDrain = false
  const settleWaiters = new Set()
  const settle = () => {
    if (pendingWrites !== 0) return
    for (const resolve of settleWaiters) resolve()
    settleWaiters.clear()
  }
  const resume = () => {
    waitingForDrain = false
    if (!failed) source.resume()
  }
  const fail = (error) => {
    if (failed) return
    failed = true
    source.pause()
    if (waitingForDrain) destination.removeListener('drain', resume)
    pendingWrites = 0
    settle()
    onFailure(error instanceof Error ? error : new Error(String(error)))
  }
  const closed = () => fail(new Error('Output destination closed before Wrangler completed.'))
  const cancel = () => {
    if (failed) return
    failed = true
    source.pause()
    if (waitingForDrain) destination.removeListener('drain', resume)
    pendingWrites = 0
    settle()
  }
  destination.on('error', fail)
  destination.on('close', closed)
  return {
    write(chunk) {
      if (failed) return
      pendingWrites += 1
      let completed = false
      const written = (error) => {
        if (completed) return
        completed = true
        pendingWrites = Math.max(0, pendingWrites - 1)
        if (error !== undefined && error !== null) fail(error)
        settle()
      }
      try {
        if (destination.write(chunk, written) || waitingForDrain || completed) return
        waitingForDrain = true
        source.pause()
        destination.once('drain', resume)
      } catch (error) {
        written(error)
      }
    },
    settled() {
      if (pendingWrites === 0) return Promise.resolve()
      return new Promise(resolve => settleWaiters.add(resolve))
    },
    cancel,
    dispose() {
      cancel()
      destination.removeListener('error', fail)
      destination.removeListener('close', closed)
    },
  }
}

function isTerminalSafe(value) {
  return !CONTROL_CHARACTER.test(value) && !BIDI_CONTROL.test(value)
}

/** Create a chunk-safe terminal filter that retains plain text only. */
export function createTerminalSanitizer() {
  let state = 'text'
  return {
    push(chunk) {
      let output = ''
      for (const character of chunk) {
        const code = character.codePointAt(0)
        if (state === 'osc' || state === 'string') {
          if (character === '\u009C' || (state === 'osc' && character === '\u0007')) {
            state = 'text'
          } else if (character === '\u001B') {
            state = `${state}-escape`
          }
          continue
        }
        if (state === 'osc-escape' || state === 'string-escape') {
          if (character === '\\' || character === '\u009C') state = 'text'
          else if (character !== '\u001B') state = state.startsWith('osc') ? 'osc' : 'string'
          continue
        }
        if (state === 'escape') {
          if (character === '[') {
            state = 'csi'
          } else if (character === ']') {
            state = 'osc'
          } else if ('PX^_'.includes(character)) {
            state = 'string'
          } else if (character !== '\u001B') {
            state = 'text'
          }
          continue
        }
        if (state === 'csi') {
          if (code >= 0x40 && code <= 0x7E) {
            state = 'text'
          }
          continue
        }
        if (character === '\u001B') {
          state = 'escape'
        } else if (character === '\u009B') {
          state = 'csi'
        } else if (character === '\u009D') {
          state = 'osc'
        } else if (character === '\u0090' || character === '\u0098'
          || character === '\u009E' || character === '\u009F') {
          state = 'string'
        } else if (!BIDI_CONTROL.test(character) && (character === '\t' || character === '\n'
          || character === '\r' || (code >= 0x20 && code <= 0x7E) || code >= 0xA0)) {
          output += character
        }
      }
      return output
    },
  }
}

function abortReason(signal, fallbackMessage) {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallbackMessage)
}

function isAbortProcessError(error, signal) {
  return signal?.aborted === true
    && error !== null
    && typeof error === 'object'
    && 'name' in error
    && error.name === 'AbortError'
}

async function detectAccounts(options) {
  const result = await options.runWrangler(['whoami', '--json'], {
    environment: wranglerEnvironment(options.environment),
    signal: options.signal,
  })
  try {
    const value = JSON.parse(result.stdout)
    if (value !== null && typeof value === 'object' && value.loggedIn === false) {
      return { accounts: [] }
    }
  } catch {
    // A nonzero command failure below preserves Wrangler's actionable diagnostic.
  }
  if (result.status !== 0) {
    throw new Error(commandFailure('Could not check Cloudflare authentication', result))
  }
  return parseWhoami(result.stdout)
}

async function requireAccounts({ runWrangler, environment, profile, signal }) {
  const result = await runWrangler(['whoami', '--json', ...profileArgs(profile)], {
    environment,
    signal,
  })
  requireSuccess(result, 'Could not read the signed-in Cloudflare account')
  const whoami = parseWhoami(result.stdout)
  if (whoami.accounts.length === 0) throw new Error('The Cloudflare login has no available accounts.')
  return whoami
}

function requireSelectedAccount(selection, accounts) {
  const id = selection.startsWith('account:') ? selection.slice('account:'.length) : ''
  const account = accounts.find(candidate => candidate.id === id)
  if (account === undefined) throw new Error('Select an available Cloudflare account.')
  return account
}

function profileArgs(profile) {
  return profile === undefined ? [] : ['--profile', profile]
}

function runtimeEnvironmentArgs(mode) {
  const target = RUNTIME_MODES[mode].environment
  return target === '' ? [] : ['--env', target]
}

function accountEnvironment(environment, accountId) {
  return { ...wranglerEnvironment(environment), CLOUDFLARE_ACCOUNT_ID: accountId }
}

function pickEnvironment(environment, keys) {
  const result = {}
  for (const key of keys) {
    const value = environment[key]
    if (value !== undefined) result[key] = value
  }
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith('LC_') && !SENSITIVE_ENV_KEY.test(key) && value !== undefined) {
      result[key] = value
    }
  }
  return result
}

function requireRuntimeMode(mode) {
  if (!Object.hasOwn(RUNTIME_MODES, mode)) {
    throw new Error(`Unsupported runtime mode: ${String(mode)}`)
  }
}

function requireSuccess(result, prefix) {
  if (result.outputFailure !== undefined) throw result.outputFailure
  if (result.status !== 0) throw new Error(commandFailure(prefix, result))
}

function commandFailure(prefix, result) {
  const detail = stripAnsi(result.stderr || result.stdout).trim()
  return detail === '' ? `${prefix}.` : `${prefix}: ${detail}`
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function formatDeployFailure(mode, result) {
  const diagnostic = stripAnsi(result.stderr || result.stdout).trim()
  const code = /\[code:\s*(\d+)\]/u.exec(diagnostic)?.[1]
  let detail
  if (code === '10021') {
    detail = 'Cloudflare rejected the Worker module during validation (code 10021).'
  } else if (code === '10027') {
    detail = 'Cloudflare rejected the Worker because it exceeds the account size limit (code 10027).'
  } else {
    const firstError = diagnostic.split(/\r?\n/u)
      .map(line => line.trim())
      .find(line => line !== '' && !line.startsWith('(node:'))
    detail = firstError === undefined
      ? 'Cloudflare did not accept the Worker upload.'
      : `Cloudflare did not accept the Worker upload${code === undefined ? '' : ` (code ${code})`}: ${firstError}`
  }
  const failure = `${detail} Run the command again with --verbose to inspect Wrangler output.`
  if (mode !== 'isolated') return failure
  return `${failure}\nThe isolated runtime requires the Workers Paid plan (starting at $5/month). `
    + 'Enable Workers Paid for this account or install the Free direct runtime.'
}

function stripAnsi(value) {
  return createTerminalSanitizer().push(value)
}

function appendBounded(current, chunk) {
  return truncateUtf8Tail(current + chunk, MAX_CAPTURE_BYTES)
}

/** Retain at most maxBytes from the end of a string without splitting UTF-8. */
export function truncateUtf8Tail(value, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer.')
  }
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  let start = bytes.byteLength - maxBytes
  while (start < bytes.byteLength && (bytes[start] & 0xC0) === 0x80) start += 1
  return bytes.toString('utf8', start)
}

async function readBoundedUtf8File(path, maxBytes) {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await file.read(bytes, offset, bytes.byteLength - offset, null)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > maxBytes) {
      throw new Error(`Wrangler deployment metadata exceeded ${maxBytes} UTF-8 bytes.`)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
  } finally {
    await file.close()
  }
}

async function createPrivateTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-install-'))
  try {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
      if (systemRoot === undefined || systemRoot === '') {
        throw new Error('Could not locate Windows PowerShell to secure installer credentials.')
      }
      const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const encodedCommand = Buffer.from(WINDOWS_PRIVATE_DIRECTORY_SCRIPT, 'utf16le').toString('base64')
      try {
        await execa(powershell, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          encodedCommand,
        ], {
          env: {
            ...process.env,
            DSH_EDGE_PRIVATE_DIRECTORY: directory,
          },
          timeout: WINDOWS_ACL_TIMEOUT_MS,
          windowsHide: true,
        })
      } catch (error) {
        throw new Error('Could not establish a private Windows ACL for installer credentials.', { cause: error })
      }
    } else {
      await chmod(directory, 0o700)
    }
    return directory
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
