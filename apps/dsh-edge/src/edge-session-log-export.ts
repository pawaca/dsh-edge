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
 * What one log may hold for the export to package it. Stored event bytes: about
 * 6 times this (worst measured: 4.3 to 6.4 times) at the peak, plus the same
 * again when the session is loaded, stays well inside a 128 MB Durable Object.
 * Events: each becomes a heap object, which dominates for many tiny events (a
 * measured 21,000-event log is fine; 100,000 is the ceiling). Each log is read
 * on its own: a session's subagents are exported one at a time, so the limits
 * apply to each log, not to their sum.
 */
export const SESSION_LOG_EXPORT_LIMITS = { bytes: 4 * 1024 * 1024, events: 100_000 } as const
export type SessionLogExportLimits = { readonly bytes: number; readonly events: number }

/** How much a log holds. `bytes` is exact up to the limit and a lower bound beyond it (counting stops there). */
export interface SessionLogSize {
  readonly bytes: number
  readonly events: number
}

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

/** A log the export refuses because reading it would not fit in memory. */
export class SessionLogTooLargeError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly size: SessionLogSize,
    readonly limits: SessionLogExportLimits,
  ) {
    super(`session log "${String(sessionId)}" holds ${describeSize(size, limits)}, over the export limit`)
  }
}

function describeSize(size: SessionLogSize, limits: SessionLogExportLimits): string {
  return size.events > limits.events
    ? `${String(size.events)} events (at most ${String(limits.events)} can be packaged)`
    : `${mib(size.bytes)} MiB or more of events (at most ${mib(limits.bytes)} MiB can be packaged)`
}

/** The 413 for a refused log, naming which log it was and what to do about it. */
export function sessionLogTooLargeResponse(error: SessionLogTooLargeError, requested: SessionId, includeDescendants: boolean): EdgeHttpError {
  const scope = error.sessionId === requested ? 'this session' : `its subagent session ${String(error.sessionId)}`
  return new EdgeHttpError(413,
    `The session log is too large to export: ${scope} holds ${describeSize(error.size, error.limits)}, held in memory per log.`
    + (includeDescendants && error.sessionId !== requested ? ' Export without subagents instead.' : ''))
}

/**
 * The budget of one export request. The persistence layer checks it at the
 * moment it reads a log, in the same synchronous step as the read, so a log that
 * grew after the pre-check (a turn appending meanwhile) cannot be materialized
 * above the limits. The request's async context carries it into the exporter's
 * streaming reads.
 */
export interface SessionLogExportBudget {
  readonly limits: SessionLogExportLimits
  /**
   * Set when a read was refused. For the root log, which the exporter reads
   * before it returns a response, the request answers 413 instead of the
   * exporter's generic 500. A subagent log is read while the archive streams,
   * after the 200 headers are sent, so a refusal there can only end the stream;
   * the pre-check covers every log first, so that needs a log that grew between
   * the check and the download.
   */
  refused?: SessionLogTooLargeError
}

export const sessionLogExportBudget = new AsyncLocalStorage<SessionLogExportBudget>()

/** Refuse (and record) a read of a log over the current export request's budget. */
export function enforceSessionLogExportBudget(sessionId: SessionId, sizeOf: (limits: SessionLogExportLimits) => SessionLogSize): void {
  const budget = sessionLogExportBudget.getStore()
  if (budget === undefined) return
  const size = sizeOf(budget.limits)
  if (size.bytes <= budget.limits.bytes && size.events <= budget.limits.events) return
  const error = new SessionLogTooLargeError(sessionId, size, budget.limits)
  budget.refused ??= error
  throw error
}

export interface SessionLogExportSources {
  /** Save a live session's pending events, as the exporter does before it reads. */
  flush(id: SessionId): Promise<void>
  /** What one session's log holds, counting no further than `limits` (see {@link SessionLogSize}). */
  size(id: SessionId, limits: SessionLogExportLimits): SessionLogSize
  /** The session and, when requested, every descendant subagent session. */
  sessionIds(id: SessionId, includeDescendants: boolean, signal: AbortSignal): Promise<readonly SessionId[]>
}

/** Refuse with a 413 when any log the export would package exceeds the limits. */
export async function assertSessionLogExportable(
  sources: SessionLogExportSources,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal: AbortSignal,
  limits: SessionLogExportLimits = SESSION_LOG_EXPORT_LIMITS,
): Promise<void> {
  const ids = await sources.sessionIds(sessionId, includeDescendants, signal)
  for (const id of ids) {
    signal.throwIfAborted()
    await sources.flush(id)
    const size = sources.size(id, limits)
    if (size.bytes > limits.bytes || size.events > limits.events) {
      throw sessionLogTooLargeResponse(new SessionLogTooLargeError(id, size, limits), sessionId, includeDescendants)
    }
  }
}
