import type { InstallerUi } from './install.mjs'

export type InstallerInterruptSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM'

export class InstallInterruptedError extends Error {
  readonly exitCode: number
  readonly signal: InstallerInterruptSignal
  outputFailureStream?: 'stderr' | 'stdout'
}

export type InstallerCommand = 'install' | 'upgrade'
export function parseCommand(args: string[]): InstallerCommand | 'help' | 'version'
export function renderInstallerIntro(
  command: InstallerCommand,
  options?: { columns?: number; isTTY?: boolean; version?: string },
): string
export function createInstallerUi(
  clack?: typeof import('@clack/prompts'),
  signal?: AbortSignal,
  writeDescriptor?: (fd: number, value: string) => number,
  output?: import('node:stream').Writable,
  writeRecovery?: (failedStream: 'stderr' | 'stdout', value: string) => Promise<boolean>,
  command?: InstallerCommand,
): InstallerUi
export function runInstaller(options?: {
  command?: InstallerCommand
  install?: (options: { command: InstallerCommand; ui: InstallerUi; signal: AbortSignal }) => Promise<unknown>
  installEdgeImpl?: typeof import('./install.mjs').installEdge
  installerUi?: InstallerUi
  outputDrainTimeoutMs?: number
  uiFactory?: (
    signal: AbortSignal,
    output: import('node:stream').Writable,
    writeRecovery: (failedStream: 'stderr' | 'stdout', value: string) => Promise<boolean>,
  ) => InstallerUi
  runtimeProcess?: {
    on(signal: InstallerInterruptSignal, handler: () => void): unknown
    removeListener(signal: InstallerInterruptSignal, handler: () => void): unknown
  }
  stderr?: import('node:stream').Writable
  stdout?: import('node:stream').Writable
  verbose?: boolean
  wranglerRunner?: typeof import('./install.mjs').executeWrangler
}): Promise<unknown>
