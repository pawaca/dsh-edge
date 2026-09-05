/**
 * Edge-local RPC and frame types. The upstream dsh-host-apiproxy package was
 * removed in 0.1.2-rc.1; its functionality migrated to the Typert Remote
 * protocol. Our Edge API layer retains its own fetch-based RPC protocol for
 * the Durable Object HTTP interface, so these types are defined locally.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { Message } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types'

// ---------------------------------------------------------------------------
// RPC envelope types
// ---------------------------------------------------------------------------

export type RpcId = Branded<'rpc-id'>
export function RpcId(id: string): RpcId { return id as RpcId }

export interface RpcRequest<P> { rpcId: RpcId; payload: P }
export interface RpcResponse<T> { rpcId: RpcId; result: RpcResult<T> }
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }
export interface RpcError { code: string; message: string; details: Record<string, unknown> }

export interface ServerRequest {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

// ---------------------------------------------------------------------------
// WebSocket frame types
// ---------------------------------------------------------------------------

export interface QueuedInboxItem {
  id: MessageId
  placement: 'queued' | 'steering' | 'context'
  message: Message
}

export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: unknown }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | { type: 'approval/requested'; sessionId: SessionId; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: SessionId; approvalId: string; outcome: unknown }
  | { type: 'question/requested'; sessionId: SessionId; questions: unknown[] }
  | { type: 'question/resolved'; sessionId: SessionId; questionRpcId: RpcId; outcome: 'answered' | 'cancelled' }
  | { type: 'session/queue'; sessionId: SessionId; items: QueuedInboxItem[] }
  | { type: 'session/jobs'; sessionId: SessionId; jobs: unknown[] }
  | { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: RpcError }

export type HostFrame =
  | { type: 'host/session-added'; sessionId: SessionId; blank: boolean; parentSessionId?: SessionId; origin?: 'subagent'; cwd?: string; agentPreset?: string }
  | { type: 'host/session-removed'; sessionId: SessionId }
  | { type: 'host/session-status'; sessionId: SessionId; running: boolean }
  | { type: 'host/agent-error'; sessionId: SessionId; message: string }
  | { type: 'host/workspace-changed'; workspace: WorkspaceView }
  | { type: 'host/workspace-removed'; workspaceId: WorkspaceId }
  | { type: 'host/workspace-order-changed'; workspaceIds: WorkspaceId[] }
  | { type: 'host/archived-sessions-changed'; archivedSessionIds: SessionId[] }
  | { type: 'host/remote-event'; event: string; args: unknown[] }
  | { type: 'stream/error'; error: RpcError }

// ---------------------------------------------------------------------------
// Session projection types
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  event: SessionEvent
  view?: unknown
}

// ---------------------------------------------------------------------------
// Edge API payload types — one per RPC method in createEdgeApi()
// ---------------------------------------------------------------------------

import type { PromptContentPart, QueueAction } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

export interface SessionListPayload {}
export interface SessionSearchPayload { query: string }
export interface SessionCreatePayload { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId; agentPreset?: string }
export interface SessionHistoryPayload { sessionId: SessionId; beforeSeq?: number; maxMessages?: number }
export interface SessionModelsPayload { sessionId: SessionId }
export interface SessionSelectModelPayload { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }
export interface SessionRenamePayload { sessionId: SessionId; title: string }
export interface SessionForkPayload { sessionId: SessionId; atSeq?: number }
export interface SessionPromptPayload {
  sessionId: SessionId
  mode: 'queue' | 'steer'
  content: PromptContentPart[]
  clientTimeZone?: string
  /**
   * Client-minted identity the Typert client persists on the exact accepted
   * user message and uses to reconcile its optimistic copy; legacy envelope
   * callers omit it and fall back to the transport rpcId.
   */
  requestId?: string
}
export interface SessionAttachmentPayload { sessionId: SessionId; attachmentId: string }
export interface SessionUpdateQueuePayload { sessionId: SessionId; itemId: MessageId; action: QueueAction }
export interface SessionCancelPayload { sessionId: SessionId }
export interface AgentPresetPayload { agentPreset: string }
export interface WorkspaceCreatePayload { path: string }
export interface WorkspaceRenamePayload { workspaceId: WorkspaceId; title: string }
export interface WorkspaceDeletePayload { workspaceId: WorkspaceId }
export interface WorkspaceInsertBeforePayload { workspaceId: WorkspaceId; beforeWorkspaceId?: WorkspaceId }
export interface WorkspaceInsertSessionBeforePayload { workspaceId: WorkspaceId; sessionId: SessionId; beforeSessionId?: SessionId }
export interface WorkspaceArchiveSessionPayload { sessionId: SessionId }
export interface SettingsUpdatePayload { ns: string; patch: object; expectedRevision?: number }
export interface SettingsReplacePayload { ns: string; section: object; expectedRevision?: number }
export interface SettingsMutatePayload { ns: string; ops: readonly SettingsPathOp[]; expectedRevision?: number }
export interface CredentialDescribePayload { refs: string[] }
export interface CredentialSetPayload { ref: string; value: string }
export interface CredentialUnsetPayload { ref: string }
