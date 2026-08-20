import type { RuntimeMode } from './install.mjs'

export interface WranglerConfigOptions {
  aliases?: Record<string, string>
  appDirectory?: string
  assetsDirectory?: string
  sourceConfigPath?: string
}

export function renderSourceModeWranglerConfig(
  mode: RuntimeMode,
  source: string,
  options?: WranglerConfigOptions,
): string

export function renderPrebuiltModeWranglerConfig(
  mode: RuntimeMode,
  source: string,
  options?: WranglerConfigOptions,
): string

export function writeSourceModeWranglerConfig(
  mode: RuntimeMode,
  destination: string,
  options?: WranglerConfigOptions,
): Promise<void>

export function writePrebuiltModeWranglerConfig(
  mode: RuntimeMode,
  destination: string,
  options?: WranglerConfigOptions,
): Promise<void>

export function workerArtifactPath(
  mode: RuntimeMode,
  options?: Pick<WranglerConfigOptions, 'appDirectory'>,
): string
