/** Edge-only HTTP metadata; conversation events use upstream SessionEvent directly. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Identifies one opaque Cloudflare Computer shell execution. */
export type EdgeExecutionId = Branded<'EdgeExecutionId'>

/** Brand an execution identifier returned by the Computer boundary. */
export function EdgeExecutionId(id: string): EdgeExecutionId {
  return id as EdgeExecutionId
}

/** Correlates one Edge agent turn with cancellation and wire responses. */
export type EdgeTurnId = Branded<'EdgeTurnId'>

/** Brand one generated opaque turn identifier without runtime validation. */
export function EdgeTurnId(id: string): EdgeTurnId {
  return id as EdgeTurnId
}

export interface EdgeSession {
  id: SessionId
  title: string | null
  agentPreset?: string
  createdAt: number
  updatedAt: number
}

export interface CreateEdgeSessionInput {
  title: string
}

/** Accepted cancellation for the active turn owned by this Worker instance. */
export interface CancelEdgeTurnResponse {
  ok: true
  sessionId: SessionId
  turnId: EdgeTurnId
}
