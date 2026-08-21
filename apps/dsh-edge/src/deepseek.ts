import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LlmAdapter,
  LlmError,
  assertUsableApiKey,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'

const API_KEY_REF = 'DEEPSEEK_API_KEY' as CredentialRef
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

/** Construct one turn-scoped DSH DeepSeek adapter that resolves its bearer token per operation. */
function createEdgeDeepSeekModel(options: {
  resolveApiKey: () => Promise<string | undefined>
  resolveAttachments?: () => AttachmentStore | undefined
  baseURL?: string
  maxTokens?: number
  reasoningEffort?: EdgeReasoningEffort
  streamIdleTimeoutMs?: number
}): DeepSeekAdapter {
  const connection = resolveAdapterOptions({
    apiKeyEnv: API_KEY_REF,
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    reasoningEffort: options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  })
  const anonymousRequestId = crypto.randomUUID() as AnonymousUserId
  return new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: async () => {
      const apiKey = await options.resolveApiKey()
      if (apiKey === undefined) {
        throw new LlmError(
          'dsh-edge: no API key for provider route "deepseek-official"; configure the DEEPSEEK_API_KEY Worker secret',
          'MISSING_CREDENTIAL',
        )
      }
      return assertUsableApiKey(apiKey, 'dsh-edge', API_KEY_REF)
    },
    // Provider telemetry must not derive identity from the owner or Durable Object id.
    resolveUserId: () => anonymousRequestId,
    ...options.resolveAttachments === undefined
      ? {}
      : { resolveAttachments: options.resolveAttachments },
  })
}

/**
 * One upstream LLM route with per-turn deployment configuration selected by
 * the loop-stamped session id. Credentials resolve independently through the
 * upstream credential service for each model operation.
 */
export class EdgeDeepSeekAdapter extends LlmAdapter {
  private readonly active = new Map<SessionId, LlmAdapter>()
  private metadataMaxTokens = DEFAULT_MAX_TOKENS
  private metadataReasoningEffort: EdgeReasoningEffort = DEFAULT_REASONING_EFFORT
  private metadata: DeepSeekAdapter

  constructor(
    private readonly resolveApiKey?: () => Promise<string | undefined>,
    private readonly resolveAttachments?: () => AttachmentStore | undefined,
  ) {
    super()
    this.metadata = createEdgeDeepSeekModel({
      resolveApiKey: () => Promise.resolve('dsh-edge-model-metadata'),
    })
  }

  bind(sessionId: SessionId, options: {
    baseURL?: string
    maxTokens?: number
    reasoningEffort?: EdgeReasoningEffort
    streamIdleTimeoutMs?: number
  }): () => void {
    this.configureDefaults(
      options.maxTokens ?? DEFAULT_MAX_TOKENS,
      options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    )
    return this.bindAdapter(sessionId, createEdgeDeepSeekModel({
      ...options,
      resolveApiKey: this.resolveApiKey ?? (() => Promise.resolve(undefined)),
      ...this.resolveAttachments === undefined
        ? {}
        : { resolveAttachments: this.resolveAttachments },
    }))
  }

  private configureDefaults(
    maxTokens: number,
    reasoningEffort: EdgeReasoningEffort,
  ): void {
    if (maxTokens === this.metadataMaxTokens
      && reasoningEffort === this.metadataReasoningEffort) return
    if (this.active.size > 0) {
      throw new LlmError(
        'dsh-edge: deployment model defaults changed while another session is active',
        'EDGE_MODEL_BUSY',
      )
    }
    this.metadata = createEdgeDeepSeekModel({
      resolveApiKey: () => Promise.resolve('dsh-edge-model-metadata'),
      maxTokens,
      reasoningEffort,
    })
    this.metadataMaxTokens = maxTokens
    this.metadataReasoningEffort = reasoningEffort
  }

  bindAdapter(sessionId: SessionId, adapter: LlmAdapter): () => void {
    if (this.active.has(sessionId)) {
      throw new LlmError(`dsh-edge: model is already bound for session "${sessionId}"`, 'EDGE_MODEL_BUSY')
    }
    this.active.set(sessionId, adapter)
    return () => {
      if (this.active.get(sessionId) === adapter) this.active.delete(sessionId)
    }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.metadata.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.metadata.providerRetryPolicy(provider)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.metadata.listModels(provider)
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.metadata.resolveModel(provider, model, signal)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = options.sessionId
    const adapter = sessionId === undefined ? undefined : this.active.get(sessionId)
    if (adapter === undefined) {
      throw new LlmError('dsh-edge: no request-scoped DeepSeek configuration is bound', 'EDGE_MODEL_NOT_BOUND')
    }
    return adapter.stream(options)
  }
}
