import type { RuntimeMode } from './install.mjs'

export interface ActivationObservation {
  attempts: number
  elapsedMs: number
  status: 'pending' | 'ready'
}

export interface ExpectedHealth {
  deploymentId: string
  shell: 'just-bash-direct' | 'just-bash-isolated'
}

export const ACTIVATION_WAIT_MS: number
export const ACTIVATION_REQUEST_TIMEOUT_MS: number
export const ACTIVATION_RETRY_MS: number

export function observePublicActivation(options: {
  publicUrl: string
  mode: RuntimeMode
  fetchImpl?: typeof fetch
  now?: () => number
  requestTimeoutMs?: number
  retryMs?: number
  signal?: AbortSignal
  sleepImpl?: (
    delay: number,
    value?: undefined,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>
  waitMs?: number
}): Promise<ActivationObservation>

export function isExpectedHealth(value: unknown, expected: ExpectedHealth): boolean
