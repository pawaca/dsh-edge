/** Deployment configuration shared by Edge health and turn admission. */

import type { EdgeReasoningEffort } from './deepseek.ts'
import {
  resolveEdgeBaseURL,
  resolveEdgeMaxOutputTokens,
  resolveEdgeModel,
  resolveEdgeReasoningEffort,
  resolveEdgeStreamIdleTimeoutMs,
} from './deepseek.ts'
import { resolveDeepSeekApiKey } from './http.ts'
import { resolveEdgeSearchBaseURL } from './web-search.ts'
import {
  resolveEdgeCommandTimeoutPolicy,
  type EdgeCommandTimeoutPolicy,
} from './workspace.ts'
import { DSH_EDGE_UPSTREAM_VERSION, DSH_EDGE_VERSION } from './release.ts'

declare const __DSH_EDGE_DEPLOYMENT_ID__: string | undefined

const LOCAL_DEPLOYMENT_ID = 'local-development'

/** Worker variables that control one Edge model and shell turn. */
export interface EdgeDeploymentConfigSource {
  LOADER?: unknown
  DSH_EDGE_ATTACHMENTS?: unknown
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_BASE_URL?: string
  DEEPSEEK_MAX_OUTPUT_TOKENS?: string
  DEEPSEEK_MODEL?: string
  DEEPSEEK_REASONING_EFFORT?: string
  DEEPSEEK_SEARCH_BASE_URL?: string
  DEEPSEEK_STREAM_IDLE_TIMEOUT_MS?: string
  DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS?: string
  DSH_EDGE_MAX_COMMAND_TIMEOUT_MS?: string
}

/** Validated deployment choices consumed by one Edge turn. */
export interface EdgeDeploymentConfig {
  baseURL: string
  maxTokens: number
  model: string
  reasoningEffort: EdgeReasoningEffort
  searchBaseURL: string
  streamIdleTimeoutMs: number
  commandTimeoutPolicy: EdgeCommandTimeoutPolicy
}

/** Secret-free deployment facts safe to project to the authenticated owner. */
export interface EdgeDeploymentProfile {
  shell: 'just-bash-direct' | 'just-bash-isolated'
  storage: 'durable-object-sqlite-vfs'
  attachmentStorage: 'private-r2' | 'unavailable'
  deploymentId: string
  apiKeyConfigured: boolean
  baseURL: string
  maxTokens: number
  model: string
  reasoningEffort: EdgeReasoningEffort
  searchBaseURL: string
  streamIdleTimeoutMs: number
  commandTimeoutPolicy: EdgeCommandTimeoutPolicy
}

/** Identify the exact Worker artifact that answered a readiness request. */
export function resolveEdgeDeploymentId(): string {
  return typeof __DSH_EDGE_DEPLOYMENT_ID__ === 'string'
    ? __DSH_EDGE_DEPLOYMENT_ID__
    : LOCAL_DEPLOYMENT_ID
}

/** Resolve every deployment choice before health succeeds or a turn is claimed. */
export function resolveEdgeDeploymentConfig(
  source: EdgeDeploymentConfigSource,
): EdgeDeploymentConfig {
  resolveDeepSeekApiKey(source.DEEPSEEK_API_KEY)
  return {
    baseURL: resolveEdgeBaseURL(source.DEEPSEEK_BASE_URL),
    maxTokens: resolveEdgeMaxOutputTokens(source.DEEPSEEK_MAX_OUTPUT_TOKENS),
    model: resolveEdgeModel(source.DEEPSEEK_MODEL),
    reasoningEffort: resolveEdgeReasoningEffort(source.DEEPSEEK_REASONING_EFFORT),
    searchBaseURL: resolveEdgeSearchBaseURL(source.DEEPSEEK_SEARCH_BASE_URL),
    streamIdleTimeoutMs: resolveEdgeStreamIdleTimeoutMs(
      source.DEEPSEEK_STREAM_IDLE_TIMEOUT_MS,
    ),
    commandTimeoutPolicy: resolveEdgeCommandTimeoutPolicy(
      source.DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS,
      source.DSH_EDGE_MAX_COMMAND_TIMEOUT_MS,
    ),
  }
}

/** Whether the deployment supplies a non-blank DeepSeek Worker binding. */
export function edgeDeploymentApiKeyConfigured(source: EdgeDeploymentConfigSource): boolean {
  return typeof source.DEEPSEEK_API_KEY === 'string'
    && source.DEEPSEEK_API_KEY.trim().length > 0
}

/** Omit URL components that commonly carry credentials from the browser projection. */
function projectedEdgeBaseURL(raw?: string): string {
  const value = resolveEdgeBaseURL(raw)
  const parsed = new URL(value)
  if (parsed.search.length === 0 && parsed.hash.length === 0) return value
  parsed.search = ''
  parsed.hash = ''
  return parsed.href
}

/** Resolve the effective runtime profile without retaining or returning a credential value. */
export function resolveEdgeDeploymentProfile(
  source: EdgeDeploymentConfigSource,
): EdgeDeploymentProfile {
  return {
    shell: source.LOADER === undefined ? 'just-bash-direct' : 'just-bash-isolated',
    storage: 'durable-object-sqlite-vfs',
    attachmentStorage: source.DSH_EDGE_ATTACHMENTS === undefined
      ? 'unavailable'
      : 'private-r2',
    deploymentId: resolveEdgeDeploymentId(),
    apiKeyConfigured: edgeDeploymentApiKeyConfigured(source),
    baseURL: projectedEdgeBaseURL(source.DEEPSEEK_BASE_URL),
    maxTokens: resolveEdgeMaxOutputTokens(source.DEEPSEEK_MAX_OUTPUT_TOKENS),
    model: resolveEdgeModel(source.DEEPSEEK_MODEL),
    reasoningEffort: resolveEdgeReasoningEffort(source.DEEPSEEK_REASONING_EFFORT),
    searchBaseURL: resolveEdgeSearchBaseURL(source.DEEPSEEK_SEARCH_BASE_URL),
    streamIdleTimeoutMs: resolveEdgeStreamIdleTimeoutMs(
      source.DEEPSEEK_STREAM_IDLE_TIMEOUT_MS,
    ),
    commandTimeoutPolicy: resolveEdgeCommandTimeoutPolicy(
      source.DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS,
      source.DSH_EDGE_MAX_COMMAND_TIMEOUT_MS,
    ),
  }
}

/** Validate the default turn configuration and return the public runtime identity. */
export function resolveEdgeDeploymentHealth(source: EdgeDeploymentConfigSource) {
  resolveEdgeDeploymentConfig(source)
  const profile = resolveEdgeDeploymentProfile(source)
  return {
    ok: true,
    service: 'dsh-edge',
    storage: profile.storage,
    attachmentStorage: profile.attachmentStorage,
    shell: profile.shell,
    agent: 'upstream-react-loop-agent',
    access: 'single-owner-cookie',
    deploymentId: profile.deploymentId,
    version: DSH_EDGE_VERSION,
    upstreamVersion: DSH_EDGE_UPSTREAM_VERSION,
    status: 'ready',
  } as const
}
