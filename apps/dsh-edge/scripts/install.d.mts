import type { RuntimeMode } from './runtime-providers.mjs'

export type { RuntimeMode }
export { RUNTIME_MODES } from './runtime-providers.mjs'
export type InstallerCommand = 'install' | 'upgrade'
export type AttachmentStorage = 'private-r2' | 'temporary-do'

export interface CloudflareAccount {
  id: string
  name: string
}

export interface CommandResult {
  interrupted?: boolean
  outputFailure?: InstallerOutputError
  status: number | null
  stdout: string
  stderr: string
}

export interface InstallerUi {
  intro(message: string): void
  step(message: string): void
  selectAccount(choices: Array<{ value: string; label: string; hint?: string }>): Promise<string>
  workerName(initialValue: string, validate: (value: string) => string | undefined): Promise<string>
  /** The Worker name already exists; `update` keeps everything and is the confirmation. */
  existingWorker(existing: {
    workerName: string
    mode: RuntimeMode
    /** The running release predates the 0.19 session format; updating migrates stored sessions. */
    sessionFormatUpgrade: boolean
  }): Promise<'update' | 'change' | 'rename' | 'cancel'>
  /** The Worker name belongs to something other than dsh-edge; it is never updated. */
  nameTaken(workerName: string): Promise<'rename' | 'cancel'>
  /** Choose what the agent can do; `current` marks an existing instance's capabilities. */
  selectCapability(current?: RuntimeMode): Promise<RuntimeMode>
  confirmDowngrade(lost: string[]): Promise<boolean>
  r2SubscriptionUnavailable(options: { activationUrl: string }): Promise<'retry' | 'cancel'>
  /** The one confirmation; for a temporary account it also accepts Cloudflare's terms. */
  confirm(summary: {
    mode: RuntimeMode
    accountLabel: string
    workerName: string
    temporary: boolean
    updating: boolean
    attachmentStorage: AttachmentStorage
  }): Promise<boolean>
  deploymentStart?(message: string): void
  deploymentFinish?(succeeded: boolean): void
  activationStart?(message: string): void
  activationFinish?(result?: import('./activation.mjs').ActivationObservation): void
  failedDeployment?(result: { claimUrl: string; workerName: string }): void
  cleanupFailure(message: string): void
  recovery(result: InstallRecovery): void
  outputFailureRecovery(
    result: InstallRecovery,
    failedStream: 'stderr' | 'stdout',
  ): boolean | Promise<boolean> | void
  /** Hand the instance to the owner, offering to open it in a browser. */
  success(result: InstallResult): void | Promise<void>
}

export interface InstallRecovery {
  claimUrl?: string
  /** Absent after an update, which keeps the existing owner key. */
  ownerSecret?: string
  publicUrl?: string
  workerName: string
}

export interface InstallResult {
  activation?: import('./activation.mjs').ActivationObservation
  publicUrl: string
  versionId?: string
  account?: CloudflareAccount
  attachmentStorage: AttachmentStorage
  claimUrl?: string
  mode: RuntimeMode
  ownerSecret?: string
  temporary: boolean
  /** Whether this run updated an existing Worker in place. */
  updated: boolean
  workerName: string
}

export const DEFAULT_WORKER_NAME: string
export const LOGIN_PROFILE: string
export class InstallCancelledError extends Error {}
export class InstallerOutputError extends Error {
  readonly stream: 'stderr' | 'stdout'
}
export function accountChoices(accounts: CloudflareAccount[], command?: InstallerCommand): Array<{
  value: string
  label: string
  hint?: string
}>
export function parseWhoami(source: string): { accounts: CloudflareAccount[]; email?: string }
export function validateWorkerName(value: string): string | undefined
export function validateOwnerSecret(value: string): string | undefined
export function generateOwnerSecret(): string
export function resolveOwnerSecret(environment?: NodeJS.ProcessEnv): string
export function attachmentBucketName(workerName: string): string
export function ensureR2Bucket(options: {
  bucketName: string
  runWrangler: (args: string[], options?: {
    environment?: NodeJS.ProcessEnv
    signal?: AbortSignal
  }) => Promise<CommandResult>
  environment?: NodeJS.ProcessEnv
  profile?: string
  signal?: AbortSignal
}): Promise<{ bucketName: string; created: boolean }>
export function wranglerEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function unauthenticatedEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function wranglerDeployArgs(options: {
  mode: RuntimeMode
  workerName: string
  secretsFile?: string
  configFile: string
  profile?: string
  temporary?: boolean
}): string[]
export function parseDeploymentOutput(source: string): { publicUrl: string; versionId?: string }
export function parseClaimUrl(source: string): string | undefined
export function parseWorkerExistence(result: CommandResult): boolean
export interface ExistingDeploymentOptions {
  workerName: string
  runWrangler: (args: string[], options?: {
    environment?: NodeJS.ProcessEnv
    signal?: AbortSignal
  }) => Promise<CommandResult>
  environment?: NodeJS.ProcessEnv
  profile?: string
  signal?: AbortSignal
}
export function truncateUtf8Tail(value: string, maxBytes: number): string
export function createOutputForwarder(
  source: NodeJS.ReadableStream,
  destination: NodeJS.WritableStream,
  onFailure: (error: Error) => void,
): {
  write(chunk: string): void
  settled(): Promise<void>
  cancel(): void
  dispose(): void
}
export function createTerminalSanitizer(): {
  push(chunk: string): string
}
export function resolveWranglerClose(options: {
  outputFailure?: InstallerOutputError
  processError?: unknown
  signal?: AbortSignal
  status: number | null
  stderr: string
  stdout: string
}): CommandResult
export function installEdge(options: {
  command?: InstallerCommand
  ui: InstallerUi
  runWrangler?: (args: string[], options?: {
    environment?: NodeJS.ProcessEnv
    interactive?: boolean
    capture?: boolean
    signal?: AbortSignal
  }) => Promise<CommandResult>
  environment?: NodeJS.ProcessEnv
  createTemporaryDirectory?: () => Promise<string>
  removePath?: typeof import('node:fs/promises').rm
  observeActivation?: (options: {
    ownerSecret?: string
    versionId?: string
    publicUrl: string
    mode: RuntimeMode
    signal?: AbortSignal
  }) => Promise<import('./activation.mjs').ActivationObservation>
  signal?: AbortSignal
}): Promise<InstallResult>
export function wranglerProcessInvocation(args: string[], options?: {
  nodeExecutable?: string
  wranglerCli?: string
}): { command: string; args: string[] }
export function executeWrangler(args: string[], options?: {
    environment?: NodeJS.ProcessEnv
    interactive?: boolean
    forwardOutput?: boolean
  capture?: boolean
  forceKillAfterDelay?: number
  invocation?: { command: string; args: string[] }
  signal?: AbortSignal
  stderrDestination?: NodeJS.WritableStream
  stdoutDestination?: NodeJS.WritableStream
}): Promise<CommandResult>

export function inspectExistingDeployment(options: ExistingDeploymentOptions): Promise<{
  mode: RuntimeMode
  attachmentStorage: AttachmentStorage
  sessionFormatUpgrade: boolean
} | null>
