export interface NpmRuntime {
  readonly platform: NodeJS.Platform
  readonly nodeExecutable: string
  readonly pathExists: (path: string) => boolean
}

export interface NpmInvocation {
  readonly command: string
  readonly args: readonly string[]
}

export interface PackedIdentity {
  readonly name: 'dsh-edge'
  readonly version: string
}

export function targetTag(version: string): 'latest' | 'next'
export function publishTag(version: string, current: string | undefined): 'latest' | 'next' | 'historical'
export function readPackedIdentity(tarball: string): PackedIdentity
export function assertReleaseIdentity(identity: PackedIdentity): PackedIdentity
export function resolveNpmInvocation(
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
  runtime?: NpmRuntime,
): NpmInvocation
