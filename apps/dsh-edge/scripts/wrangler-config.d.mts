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
  /** Container mode: build the checked-in Dockerfile instead of deploying the published image. */
  localContainerImage?: boolean
  /** Container mode: deploy this registry reference instead of the release image. */
  containerImage?: string
  /** Container mode: the release version whose published image to deploy. */
  version?: string
  /** The deployed Worker name; it also names the Worker's Container application. */
  workerName?: string
}

export const CONTAINER_IMAGE_REPOSITORY: string
export function containerImageReference(version?: string): string
export function containerApplicationName(workerName: string): string

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
