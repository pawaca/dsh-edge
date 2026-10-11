/**
 * Guard for upstream's session log export (`dsh-session-log-export`).
 *
 * The upstream exporter reads a session's whole log into memory and joins it
 * into one string before compressing it. Measured on 5 to 22 MiB logs with Chinese
 * text, that holds 4.3 times (a few large events) to 6.4 times (21,000 small
 * events, or token-level streams) the stored event bytes on the heap, and a session that is
 * loaded in the Durable Object already holds about as much again. A Durable
 * Object has 128 MB for everything it runs, so a larger log would exhaust its
 * memory and restart the object under every other session. The Edge therefore
 * refuses such a log up front with a clear error instead of attempting it.
 * Lifting the limit needs an exporter that pages the log into the archive,
 * which is Edge-owned code rather than the upstream package (#317).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EdgeHttpError } from './http.ts'

/**
 * Stored event bytes of one log the export will package: about 6 times this
 * (worst measured: 4.3 to 6.4 times) at the peak, plus the same again when the
 * session is loaded, stays well inside a 128 MB Durable Object. Each log is
 * read on its own: a session's subagents are exported one at a time, so the
 * limit applies to each log, not to their sum.
 */
export const MAX_SESSION_LOG_EXPORT_BYTES = 4 * 1024 * 1024

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

/** A log the export refuses because reading it would not fit in memory. */
export class SessionLogTooLargeError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly bytes: number,
    readonly limitBytes: number,
  ) {
    super(`session log "${String(sessionId)}" holds ${mib(bytes)} MiB of events, over the ${mib(limitBytes)} MiB export limit`)
  }
}

/** The 413 for a refused log, naming which log it was and what to do about it. */
export function sessionLogTooLargeResponse(error: SessionLogTooLargeError, requested: SessionId, includeDescendants: boolean): EdgeHttpError {
  const scope = error.sessionId === requested ? 'this session' : `its subagent session ${String(error.sessionId)}`
  return new EdgeHttpError(413,
    `The session log is too large to export: ${scope} holds ${mib(error.bytes)} MiB of events, and the Edge can package at most ${mib(error.limitBytes)} MiB per log in memory.`
    + (includeDescendants && error.sessionId !== requested ? ' Export without subagents instead.' : ''))
}

/**
 * The byte budget of one export request. The persistence layer checks it at
 * the moment it reads a log, in the same synchronous step as the read, so a
 * log that grew after the pre-check (a turn appending meanwhile) or a subagent
 * log still cannot be materialized above the limit. The request's async
 * context carries it into the exporter's streaming reads.
 */
export interface SessionLogExportBudget {
  readonly limitBytes: number
  /** Set when a read was refused, so the request can answer 413 instead of the exporter's generic 500. */
  refused?: SessionLogTooLargeError
}

export const sessionLogExportBudget = new AsyncLocalStorage<SessionLogExportBudget>()

/** Refuse (and record) a read of `bytes` stored bytes when the current export request's budget is exceeded. */
export function enforceSessionLogExportBudget(sessionId: SessionId, bytes: () => number): void {
  const budget = sessionLogExportBudget.getStore()
  if (budget === undefined) return
  const stored = bytes()
  if (stored <= budget.limitBytes) return
  const error = new SessionLogTooLargeError(sessionId, stored, budget.limitBytes)
  budget.refused ??= error
  throw error
}

export interface SessionLogExportSources {
  /** Save a live session's pending events, as the exporter does before it reads. */
  flush(id: SessionId): Promise<void>
  /** Stored event bytes of one session. */
  eventBytes(id: SessionId): number
  /** The session and, when requested, every descendant subagent session. */
  sessionIds(id: SessionId, includeDescendants: boolean, signal: AbortSignal): Promise<readonly SessionId[]>
}

/** Refuse with a 413 when any log the export would package exceeds the budget. */
export async function assertSessionLogExportable(
  sources: SessionLogExportSources,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal: AbortSignal,
  limitBytes = MAX_SESSION_LOG_EXPORT_BYTES,
): Promise<void> {
  const ids = await sources.sessionIds(sessionId, includeDescendants, signal)
  for (const id of ids) {
    signal.throwIfAborted()
    await sources.flush(id)
    const bytes = sources.eventBytes(id)
    if (bytes > limitBytes) throw sessionLogTooLargeResponse(new SessionLogTooLargeError(id, bytes, limitBytes), sessionId, includeDescendants)
  }
}
