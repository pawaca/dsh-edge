export type RuntimeMode = 'direct' | 'isolated'
export type InstallerCommand = 'install' | 'upgrade'

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
  selectRuntime(): Promise<RuntimeMode>
  selectAccount(choices: Array<{ value: string; label: string; hint?: string }>): Promise<string>
  workerName(initialValue: string, validate: (value: string) => string | undefined): Promise<string>
  workerConflict(workerName: string): Promise<'rename' | 'update' | 'cancel'>
  selectOwnerSecretMode(): Promise<'generate' | 'custom'>
  ownerSecret(validate: (value: string) => string | undefined): Promise<string>
  deepSeekKey(validate: (value: string) => string | undefined): Promise<string>
  confirm(summary: {
    mode: RuntimeMode
    modeLabel: string
    accountLabel: string
    workerName: string
    paid: boolean
    temporary: boolean
  }): Promise<boolean>
  acceptTemporaryTerms(): Promise<boolean>
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
  success(result: InstallResult): void
}

export interface InstallRecovery {
  claimUrl?: string
  ownerSecret: string
  publicUrl?: string
  workerName: string
}

export interface InstallResult {
  activation?: import('./activation.mjs').ActivationObservation
  publicUrl: string
  versionId?: string
  account?: CloudflareAccount
  claimUrl?: string
  mode: RuntimeMode
  ownerSecret: string
  temporary: boolean
  workerName: string
}

export const DEFAULT_WORKER_NAME: string
export const LOGIN_PROFILE: string
export const RUNTIME_MODES: Readonly<Record<RuntimeMode, Readonly<{
  environment: string
  expectedShell: string
  label: string
}>>>
export class InstallCancelledError extends Error {}
export class InstallerOutputError extends Error {
  readonly stream: 'stderr' | 'stdout'
}
export function accountChoices(mode: RuntimeMode, accounts: CloudflareAccount[], command?: InstallerCommand): Array<{
  value: string
  label: string
  hint?: string
}>
export function parseWhoami(source: string): { accounts: CloudflareAccount[]; email?: string }
export function validateWorkerName(value: string): string | undefined
export function validateOwnerSecret(value: string): string | undefined
export function validateDeepSeekKey(value: string): string | undefined
export function generateOwnerSecret(): string
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
  secretsFile: string
  configFile: string
  profile?: string
  temporary?: boolean
}): string[]
export function parseDeploymentOutput(source: string): { publicUrl: string; versionId?: string }
export function parseClaimUrl(source: string): string | undefined
export function parseWorkerExistence(result: CommandResult): boolean
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
