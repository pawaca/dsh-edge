const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MAX_TOKENS = 8_192
const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_REASONING_EFFORT = 'off'
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/

export type EdgeReasoningEffort = 'off' | 'low' | 'high' | 'max'

/** Resolve and validate the DeepSeek HTTP endpoint selected by deployment configuration. */
export function resolveEdgeBaseURL(raw?: string): string {
  const value = raw ?? DEFAULT_BASE_URL
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('dsh-edge: DEEPSEEK_BASE_URL must be a valid HTTP(S) URL')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0
    || parsed.password.length > 0) {
    throw new Error('dsh-edge: DEEPSEEK_BASE_URL must be a valid HTTP(S) URL without credentials')
  }
  return value
}

/** Resolve the DeepSeek model id selected by Worker deployment configuration. */
export function resolveEdgeModel(raw?: string): string {
  if (raw === undefined) return DEFAULT_MODEL
  if (!MODEL_PATTERN.test(raw)) {
    throw new Error('dsh-edge: DEEPSEEK_MODEL must be a valid model id of at most 128 characters')
  }
  return raw
}

/** Resolve the DeepSeek thinking policy selected by Worker deployment configuration. */
export function resolveEdgeReasoningEffort(raw?: string): EdgeReasoningEffort {
  if (raw === undefined) return DEFAULT_REASONING_EFFORT
  if (raw !== 'off' && raw !== 'low' && raw !== 'high' && raw !== 'max') {
    throw new Error('dsh-edge: DEEPSEEK_REASONING_EFFORT must be one of off, low, high, or max')
  }
  return raw
}

/** Resolve the optional Worker deployment override before an SSE turn opens. */
export function resolveEdgeStreamIdleTimeoutMs(raw?: string): number {
  if (raw === undefined) return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      'dsh-edge: DEEPSEEK_STREAM_IDLE_TIMEOUT_MS must be a positive integer',
    )
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `dsh-edge: DEEPSEEK_STREAM_IDLE_TIMEOUT_MS must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return value
}

/** Resolve the request output cap selected by Worker deployment configuration. */
export function resolveEdgeMaxOutputTokens(raw?: string): number {
  if (raw === undefined) return DEFAULT_MAX_TOKENS
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      'dsh-edge: DEEPSEEK_MAX_OUTPUT_TOKENS must be a positive integer',
    )
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `dsh-edge: DEEPSEEK_MAX_OUTPUT_TOKENS must be no greater than ${Number.MAX_SAFE_INTEGER}`,
    )
  }
  return value
}
