export interface NpmInvocationOptions {
  platform?: NodeJS.Platform
  nodeExecutable?: string
  environment?: NodeJS.ProcessEnv
  pathExists?: (path: string) => boolean
}

export interface NpmInvocation {
  command: string
  args: string[]
}

/**
 * Resolve npm to a directly executable command on the current platform.
 * @param options Resolution inputs used by the release verifier.
 * @returns The executable and leading arguments for npm.
 */
export function resolveNpmInvocation(options?: NpmInvocationOptions): NpmInvocation

/**
 * Install and exercise one packed dsh-edge artifact outside the workspace.
 * @param input Tarball path from the command line.
 */
export function verifyPacked(input?: string): void
