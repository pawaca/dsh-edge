/**
 * Guard for upstream's session log export (`dsh-session-log-export`).
 *
 * The upstream exporter reads a session's whole log into memory and joins it
 * into one string before compressing it. Measured on two 5 to 7 MiB logs with
 * Chinese text, that holds 4.3 times (a few large events) to 6.1 times (21,000
 * small events) the stored event bytes on the heap, and a session that is
 * loaded in the Durable Object already holds about as much again. A Durable
 * Object has 128 MB for everything it runs, so a larger log would exhaust its
 * memory and restart the object under every other session. The Edge therefore
 * refuses such a log up front with a clear error instead of attempting it.
 * Lifting the limit needs an exporter that pages the log into the archive,
 * which is Edge-owned code rather than the upstream package (#317).
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { EdgeHttpError } from './http.ts'

/**
 * Stored event bytes of one log the export will package: about 6 times this
 * (worst measured) at the peak, plus the same again when the session is loaded,
 * stays well inside a 128 MB Durable Object. Each log is read on its own: a
 * session's subagents are exported one at a time, so the limit applies to each
 * log, not to their sum.
 */
export const MAX_SESSION_LOG_EXPORT_BYTES = 4 * 1024 * 1024

export interface SessionLogExportSources {
  /** Save a live session's pending events, as the exporter does before it reads. */
  flush(id: SessionId): Promise<void>
  /** Stored event bytes of one session. */
  eventBytes(id: SessionId): number
  /** The session and, when requested, every descendant subagent session. */
  sessionIds(id: SessionId, includeDescendants: boolean, signal: AbortSignal): Promise<readonly SessionId[]>
}

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

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
    if (bytes > limitBytes) {
      const scope = id === sessionId ? 'this session' : `its subagent session ${String(id)}`
      throw new EdgeHttpError(413,
        `The session log is too large to export: ${scope} holds ${mib(bytes)} MiB of events, and the Edge can package at most ${mib(limitBytes)} MiB per log in memory.`
        + (includeDescendants && id !== sessionId ? ' Export without subagents instead.' : ''))
    }
  }
}
