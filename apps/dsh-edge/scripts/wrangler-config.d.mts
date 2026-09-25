import type { RuntimeMode } from './install.mjs'

/** A deployable Worker environment: a runtime mode or the Container environment. */
export type PrebuiltMode = RuntimeMode | 'container'

export interface WranglerConfigOptions {
  aliases?: Record<string, string>
  appDirectory?: string
  assetsDirectory?: string
  r2BucketName?: string
  enableImages?: boolean
  sourceConfigPath?: string
}

export function renderSourceModeWranglerConfig(
  mode: RuntimeMode,
  source: string,
  options?: WranglerConfigOptions,
): string

export function renderPrebuiltModeWranglerConfig(
  mode: PrebuiltMode,
  source: string,
  options?: WranglerConfigOptions,
): string

export function writeSourceModeWranglerConfig(
  mode: RuntimeMode,
  destination: string,
  options?: WranglerConfigOptions,
): Promise<void>

export function writePrebuiltModeWranglerConfig(
  mode: PrebuiltMode,
  destination: string,
  options?: WranglerConfigOptions,
): Promise<void>

export function workerArtifactPath(
  mode: PrebuiltMode,
  options?: Pick<WranglerConfigOptions, 'appDirectory'>,
): string
