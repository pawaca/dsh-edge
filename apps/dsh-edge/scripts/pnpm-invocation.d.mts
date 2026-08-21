export interface PnpmInvocationOptions {
  nodeExecutable?: string
}

export interface PnpmInvocation {
  command: string
  args: string[]
}

export declare function resolvePnpmInvocation(
  pnpm: string | undefined,
  args: string[],
  options?: PnpmInvocationOptions,
): PnpmInvocation
