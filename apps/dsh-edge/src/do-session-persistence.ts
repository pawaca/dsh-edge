/** Upstream SessionPersistence implemented over Cloudflare Durable Object SQL. */

import { Context } from '@deepseek-ai/cordis'
import {
  SESSION_FORMAT_VERSION,
  decodeStorageRecord,
  packChunkRuns,
} from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionId,
  SessionHeader,
  SessionPreparation,
  SurfaceOp,
} from '@deepseek-ai/dsh-session'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  PersistenceCoordinator,
  SessionFormatUnsupportedError,
  SessionPersistence,
  SessionPersistenceRevision,
  sessionFormatVersionRefusal,
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceRevision as PersistenceRevision,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import {
  SessionTitleProviderId,
  type SessionTitleEventData,
  type SessionTitleSource,
} from '@deepseek-ai/dsh-session-title'

/** Versions the DO table layout; SessionHeader.version owns the event format. */
const DO_SESSION_SCHEMA_VERSION = 2

interface DurableObjectSessionPersistenceConfig {
  storage: DurableObjectStorage
  preparedSessionCacheSize?: number
  writeBatchMaxDelayMs?: number
}

interface StateRow extends Record<string, SqlStorageValue> {
  schema_version: number
  store_id: string
}

interface HeaderRow extends Record<string, SqlStorageValue> {
  id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  origin: string | null
  delegation_depth: number | null
  agent_preset: string | null
  incarnation: string
  revision: number
}

interface BlankSessionRow extends Record<string, SqlStorageValue> {
  id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  origin: string | null
  delegation_depth: number | null
  agent_preset: string | null
}

interface EventRow extends Record<string, SqlStorageValue> {
  seq: number
  type: string
  time: number
  data: string
  source_event_seqs: string | null
  surface_op: string | null
  ignorable: number | null
}

/** Minimal request-routing projection read without materializing a cold log. */
export interface EdgeStoredModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface LastSequenceRow extends Record<string, SqlStorageValue> {
  seq: number | null
}

interface HistoryBoundaryRow extends Record<string, SqlStorageValue> {
  seq: number
  source_event_seqs: string | null
}

/** Shared response budget applied before live/cold history paths diverge. */
export const EDGE_HISTORY_PAGE_LIMITS = {
  maxEvents: 65_536,
  maxStoredBytes: 8 * 1_024 * 1_024,
  maxMessages: 50,
} as const

interface SessionSummaryRow extends HeaderRow {
  updated_at: number | null
  last_prompt_at: number | null
  last_seq: number | null
  blank: number
  title_seq: number | null
  title_time: number | null
  title_data: string | null
}

/** Expensive correlated-subquery summary; retained only for per-session recomputation. */
const SESSION_SUMMARY_SELECT = `SELECT s.id, s.version, s.created_at, s.cwd, s.parent_session,
        s.seed_length, s.origin, s.delegation_depth, s.agent_preset, s.incarnation, s.revision,
        (SELECT e.time FROM dsh_session_events e
         WHERE e.session_id = s.id ORDER BY e.seq DESC LIMIT 1) AS updated_at,
        (SELECT e.time FROM dsh_session_events e
         WHERE e.session_id = s.id AND e.type = 'user/message'
           AND json_extract(e.data, '$.source.kind') = 'user'
         ORDER BY e.seq DESC LIMIT 1) AS last_prompt_at,
        (SELECT e.seq FROM dsh_session_events e
         WHERE e.session_id = s.id ORDER BY e.seq DESC LIMIT 1) AS last_seq,
        NOT EXISTS (
          SELECT 1 FROM dsh_session_events e
          WHERE e.session_id = s.id AND e.type = 'turn/start'
        ) AS blank,
        (SELECT e.seq FROM dsh_session_events e
         WHERE e.session_id = s.id AND e.type = 'session/title'
         ORDER BY e.seq DESC LIMIT 1) AS title_seq,
        (SELECT e.time FROM dsh_session_events e
         WHERE e.session_id = s.id AND e.type = 'session/title'
         ORDER BY e.seq DESC LIMIT 1) AS title_time,
        (SELECT e.data FROM dsh_session_events e
         WHERE e.session_id = s.id AND e.type = 'session/title'
         ORDER BY e.seq DESC LIMIT 1) AS title_data
 FROM dsh_sessions s`

const SESSION_SUMMARY_MATERIALIZED = `SELECT s.id, s.version, s.created_at, s.cwd, s.parent_session,
        s.seed_length, s.origin, s.delegation_depth, s.agent_preset, s.incarnation, s.revision,
        sm.updated_at, sm.last_prompt_at, sm.last_seq, sm.blank,
        sm.title_seq, sm.title_time, sm.title_data
 FROM dsh_sessions s
 JOIN dsh_session_summaries sm ON s.id = sm.session_id`

/** One cheap session-list item derived from canonical header/event rows. */
export interface EdgeStoredSessionSummary {
  meta: SessionHeader
  titleEvent?: SessionEvent<'session/title'>
  updatedAt: number
  lastPromptAt: number | null
  lastSeq: number
  blank: boolean
}

/** One bounded session-list page. */
export interface EdgeStoredSessionSummaryPage {
  sessions: EdgeStoredSessionSummary[]
  hasMore: boolean
}

/** One validated page retained within the Edge replay byte budget. */
export interface EdgeEventPage {
  meta: SessionHeader
  events: SessionEvent[]
  hasMore: boolean
}

/** One upstream-compatible history window selected before event payloads are decoded. */
export interface EdgeStoredHistoryPage {
  summary: EdgeStoredSessionSummary
  events: SessionEvent[]
  hasMore: boolean
}

/** Cordis service + backend primitives; coordinator owns all session orchestration. */
export class DurableObjectSessionPersistence
  extends SessionPersistence
  implements PersistenceBackend<number> {
  static inject = ['sessions']

  override readonly name = 'session-persistence-durable-object'
  override readonly supportsRawArtifacts = false

  private readonly storage: DurableObjectStorage
  private readonly storeIdentity: string
  private readonly coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, config: DurableObjectSessionPersistenceConfig) {
    super(ctx)
    this.storage = config.storage
    this.storeIdentity = this.initialize()
    this.coordinator = new PersistenceCoordinator(ctx, this, {
      preparedSessionCacheSize: config.preparedSessionCacheSize
        ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs
        ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  /** Prevent disposal from retrying a failed first materialization. */
  abandonUnmaterializedSession(session: Session): Promise<void> {
    return (this.coordinator as never as { abandonUnmaterialized(s: Session): Promise<void> }).abandonUnmaterialized(session)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  /** Read and canonically validate one Edge-only replay page. */
  readEventPage(
    id: SessionId,
    fromSeq: number,
    limit: number,
    maxStoredBytes: number,
    signal?: AbortSignal,
  ): Promise<EdgeEventPage> {
    if (!Number.isSafeInteger(maxStoredBytes) || maxStoredBytes <= 0) {
      return Promise.reject(new TypeError(
        `readEventPage maxStoredBytes must be a positive safe integer, got ${String(maxStoredBytes)}`,
      ))
    }
    return (this.coordinator as never as { readValidatedPage: (...args: unknown[]) => Promise<EdgeEventPage> }).readValidatedPage(
      id,
      fromSeq,
      limit,
      (pageId: SessionId, pageFromSeq: number, pageLimit: number, pageSignal: AbortSignal | undefined) => this.loadStoredPage(
        pageId,
        pageFromSeq,
        pageLimit,
        maxStoredBytes,
        pageSignal,
      ),
      signal,
    )
  }

  /** Select a cold history boundary in SQL, then decode only that raw event window. */
  async readHistoryPage(
    id: SessionId,
    beforeSeq: number | undefined,
    maxMessages: number,
    signal?: AbortSignal,
  ): Promise<EdgeStoredHistoryPage | undefined> {
    const summary = this.readSessionSummary(id)
    if (summary === undefined) return undefined
    const boundaryLimit = Math.min(maxMessages, EDGE_HISTORY_PAGE_LIMITS.maxMessages)
    const upperExclusive = Math.min(beforeSeq ?? summary.lastSeq + 1, summary.lastSeq + 1)
    if (upperExclusive <= 0) return { summary, events: [], hasMore: false }
    const boundaryRows = this.storage.sql.exec<HistoryBoundaryRow>(
      `SELECT seq, source_event_seqs FROM dsh_session_events
       WHERE session_id = ? AND seq < ?
         AND type IN ('user/message', 'assistant/message')
         AND surface_op = '"append"'
       ORDER BY seq DESC LIMIT ?`,
      id,
      upperExclusive,
      boundaryLimit,
    ).toArray()
    const oldestBoundary = boundaryRows.at(-1)
    const boundary = boundaryRows.length < boundaryLimit || oldestBoundary === undefined
      ? 0
      : historyGroupStart(oldestBoundary)
    if (boundary >= upperExclusive) return { summary, events: [], hasMore: boundary > 0 }
    const page = await (this.coordinator as never as { readValidatedPage: (...args: unknown[]) => Promise<EdgeEventPage> }).readValidatedPage(
      id,
      boundary,
      EDGE_HISTORY_PAGE_LIMITS.maxEvents,
      (pageId: SessionId, pageFromSeq: number, pageLimit: number, pageSignal: AbortSignal | undefined) => {
        if (pageFromSeq !== boundary) {
          return Promise.reject(new Error(
            `stored session ${id} history contains a legacy event that requires an unbounded prefix`,
          ))
        }
        return this.loadStoredPage(
          pageId,
          pageFromSeq,
          pageLimit,
          EDGE_HISTORY_PAGE_LIMITS.maxStoredBytes,
          pageSignal,
          upperExclusive,
        )
      },
      signal,
    )
    if (page.hasMore) {
      throw new Error(
        `stored session ${id} history page exceeds the Edge limit of ${EDGE_HISTORY_PAGE_LIMITS.maxEvents} events or ${EDGE_HISTORY_PAGE_LIMITS.maxStoredBytes} stored bytes`,
      )
    }
    return { summary, events: page.events, hasMore: boundary > 0 }
  }

  loadStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<number> | undefined> {
    return promiseFromSync(() => {
      signal?.throwIfAborted()
      const snapshot = this.storage.transactionSync(() => {
        const row = this.rowFor(id)
        if (row === undefined) return undefined
        return { row, eventRows: this.eventRows(id, 0) }
      })
      signal?.throwIfAborted()
      if (snapshot === undefined) return undefined
      const { preserved, tornFrom } = scanRows(snapshot.eventRows)
      return {
        meta: rowToHeader(snapshot.row),
        events: preserved,
        revision: revisionOf(this.storeIdentity, snapshot.row),
        ...tornFrom === undefined ? {} : { tornMarker: tornFrom },
      }
    })
  }

  readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<PersistenceRevision | undefined> {
    return promiseFromSync(() => {
      signal?.throwIfAborted()
      const row = this.rowFor(id)
      signal?.throwIfAborted()
      return row === undefined ? undefined : revisionOf(this.storeIdentity, row)
    })
  }

  loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    return promiseFromSync(() => {
      signal?.throwIfAborted()
      const snapshot = this.storage.transactionSync(() => {
        const row = this.rowFor(id)
        if (row === undefined) return undefined
        return { row, eventRows: this.eventRows(id, fromSeq) }
      })
      signal?.throwIfAborted()
      if (snapshot === undefined) return undefined
      return {
        meta: rowToHeader(snapshot.row),
        events: scanRows(snapshot.eventRows, fromSeq).preserved,
      }
    })
  }

  private loadStoredPage(
    id: SessionId,
    fromSeq: number,
    limit: number,
    maxStoredBytes: number,
    signal?: AbortSignal,
    toSeqExclusive?: number,
  ): Promise<EdgeEventPage | undefined> {
    return promiseFromSync(() => {
      signal?.throwIfAborted()
      const page = this.storage.transactionSync(() => {
        const headerRow = this.rowFor(id)
        if (headerRow === undefined) return undefined
        const sqlRows = this.eventRowRangeContaining(id, fromSeq, limit, toSeqExclusive)
        const lastTurnEnd = this.lastCommittedSequence(id)
        const events: SessionEvent[] = []
        let storedBytes = 0
        let hasMore = false
        let nextSeq = fromSeq
        for (const row of sqlRows) {
          const rowBytes = new TextEncoder().encode(row.data).byteLength
          if (events.length >= limit || rowBytes > maxStoredBytes - storedBytes) {
            hasMore = true
            break
          }
          let decoded: SessionEvent[]
          try {
            decoded = rowToEvents(row)
          } catch {
            if (row.seq <= lastTurnEnd) {
              throw new Error(`corrupt session log: unparsable committed event at seq ${row.seq}`)
            }
            break
          }
          storedBytes += rowBytes
          for (const event of decoded) {
            if (event.seq < fromSeq) continue
            if (toSeqExclusive !== undefined && event.seq >= toSeqExclusive) continue
            if (event.seq !== nextSeq) {
              if (event.seq <= lastTurnEnd) {
                throw new Error(
                  `corrupt session log: seq gap in committed region (expected ${nextSeq}, got ${event.seq})`,
                )
              }
              hasMore = false
              break
            }
            if (events.length >= limit) { hasMore = true; break }
            events.push(event)
            nextSeq = event.seq + 1
          }
        }
        return {
          meta: rowToHeader(headerRow),
          events,
          hasMore,
        }
      })
      signal?.throwIfAborted()
      return page
    })
  }

  appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    return promiseFromSync(() => {
      this.storage.transactionSync(() => {
        if (!isMaterialized) this.writeRow(meta)
        const packed = packChunkRuns(events as SessionEvent[])
        for (const record of packed) this.insertEvent(meta.id, record as SessionEvent)
        const updated = this.storage.sql.exec(
          'UPDATE dsh_sessions SET revision = revision + 1 WHERE id = ?',
          meta.id,
        )
        if (updated.rowsWritten !== 1) throw new Error(`session ${meta.id} is not materialized`)
        this.storage.sql.exec('DELETE FROM dsh_edge_blank_sessions WHERE id = ?', meta.id)
        this.updateSummaryFromBatch(meta.id, events)
      })
    })
  }

  commitRepair(
    meta: SessionHeader,
    tornMarker: number | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    return promiseFromSync(() => {
      this.storage.transactionSync(() => {
        if (tornMarker !== undefined) {
          this.storage.sql.exec(
            'DELETE FROM dsh_session_events WHERE session_id = ? AND seq >= ?',
            meta.id,
            tornMarker,
          )
        }
        for (const event of closers) this.insertEvent(meta.id, event)
        if (tornMarker !== undefined || closers.length > 0) {
          this.storage.sql.exec(
            'UPDATE dsh_sessions SET revision = revision + 1 WHERE id = ?',
            meta.id,
          )
          this.recomputeSummary(meta.id)
        }
      })
    })
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return promiseFromSync(() => {
      signal?.throwIfAborted()
      const rows = this.storage.sql.exec<HeaderRow>(
        `SELECT id, version, created_at, cwd, parent_session, seed_length, origin,
                delegation_depth, agent_preset, incarnation, revision
         FROM dsh_sessions`,
      ).toArray()
      signal?.throwIfAborted()
      const headers = rows.map(rowToHeader)
      const blankRows = this.storage.sql.exec<BlankSessionRow>(
        `SELECT id, version, created_at, cwd, parent_session, seed_length, origin,
                delegation_depth, agent_preset
         FROM dsh_edge_blank_sessions`,
      ).toArray()
      for (const row of blankRows) {
        headers.push(rowToHeader(row as unknown as HeaderRow))
      }
      return headers
    })
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return promiseFromSync(() => {
      signal?.throwIfAborted()
      const rows = this.storage.sql.exec<HeaderRow>(
        `SELECT id, version, created_at, cwd, parent_session, seed_length, origin,
                delegation_depth, agent_preset, incarnation, revision
         FROM dsh_sessions`,
      ).toArray()
      signal?.throwIfAborted()
      return rows.map(row => ({
        header: rowToHeader(row),
        revision: revisionOf(this.storeIdentity, row),
      }))
    })
  }

  /** Test one materialized session identity without listing stored headers. */
  hasSession(id: SessionId): boolean {
    return this.rowFor(id) !== undefined
  }

  /** Read and format-check one canonical header without touching event rows. */
  readSessionHeader(id: SessionId): SessionHeader | undefined {
    const row = this.rowFor(id)
    if (row === undefined) return undefined
    const header = rowToHeader(row)
    if (header.version !== SESSION_FORMAT_VERSION) {
      throw new SessionFormatUnsupportedError(
        sessionFormatVersionRefusal(header.id, header.version),
      )
    }
    return header
  }

  /** Read the latest canonical model selection recorded by an upstream request/header. */
  readLatestModelSelection(id: SessionId): EdgeStoredModelSelection | undefined {
    const row = this.storage.sql.exec<Pick<EventRow, 'data'>>(
      `SELECT data FROM dsh_session_events
       WHERE session_id = ? AND type = 'request/header'
       ORDER BY seq DESC LIMIT 1`,
      id,
    ).toArray()[0]
    if (row === undefined) return undefined
    let data: unknown
    try {
      data = JSON.parse(row.data)
    } catch {
      throw new Error(`stored session ${id} has unparsable request/header data`)
    }
    const config = requestHeaderConfig(data)
    if (config === undefined) {
      throw new Error(`stored session ${id} has invalid request/header data`)
    }
    return config
  }

  /** Retain the process-local blank identity across Durable Object hibernation. */
  retainBlankSession(meta: SessionHeader): Promise<void> {
    return promiseFromSync(() => {
      this.storage.sql.exec(
        `INSERT INTO dsh_edge_blank_sessions
          (id, version, created_at, cwd, parent_session, seed_length, origin,
           delegation_depth, agent_preset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        meta.id,
        meta.version,
        meta.createdAt,
        meta.cwd ?? null,
        meta.parentSession ?? null,
        meta.seedLength ?? null,
        meta.origin ?? null,
        meta.delegationDepth ?? null,
        meta.agentPreset ?? null,
      )
    })
  }

  /** Read one retained blank header without treating it as a canonical log. */
  readBlankSession(id: SessionId): SessionHeader | undefined {
    const row = this.storage.sql.exec<BlankSessionRow>(
      `SELECT id, version, created_at, cwd, parent_session, seed_length, origin,
              delegation_depth, agent_preset
       FROM dsh_edge_blank_sessions WHERE id = ?`,
      id,
    ).toArray()[0]
    return row === undefined ? undefined : blankRowToHeader(row)
  }

  /** Read every retained blank header for the upstream session-list baseline. */
  readAllBlankSessions(): SessionHeader[] {
    return this.storage.sql.exec<BlankSessionRow>(
      `SELECT id, version, created_at, cwd, parent_session, seed_length, origin,
              delegation_depth, agent_preset
       FROM dsh_edge_blank_sessions ORDER BY created_at DESC, id ASC`,
    ).toArray().map(blankRowToHeader)
  }

  /** Read only the newest retained blank headers needed by bounded consumers. */
  readRecentBlankSessions(limit: number): SessionHeader[] {
    return this.storage.sql.exec<BlankSessionRow>(
      `SELECT id, version, created_at, cwd, parent_session, seed_length, origin,
              delegation_depth, agent_preset
       FROM dsh_edge_blank_sessions ORDER BY created_at DESC, id ASC LIMIT ?`,
      limit,
    ).toArray().map(blankRowToHeader)
  }

  /** Promote a retained blank into the canonical empty-log schema before cold resume. */
  materializeBlankSession(id: SessionId): Promise<boolean> {
    return promiseFromSync(() => this.storage.transactionSync(() => {
      const blank = this.readBlankSession(id)
      if (blank === undefined) return false
      if (this.rowFor(id) === undefined) this.writeRow(blank)
      this.storage.sql.exec('DELETE FROM dsh_edge_blank_sessions WHERE id = ?', id)
      this.insertEmptyLogSummary(id, blank.createdAt)
      return true
    }))
  }

  /** Read one canonical header/title summary without materializing its event log. */
  readSessionSummary(id: SessionId): EdgeStoredSessionSummary | undefined {
    const row = this.storage.sql.exec<SessionSummaryRow>(
      `${SESSION_SUMMARY_MATERIALIZED} WHERE s.id = ?`,
      id,
    ).toArray()[0]
    return row === undefined ? undefined : rowToStoredSessionSummary(row)
  }

  /** Read a bounded metadata/title page without materializing session logs. */
  readSessionSummaryPage(
    after: SessionId | undefined,
    limit: number,
  ): EdgeStoredSessionSummaryPage | undefined {
    return this.storage.transactionSync(() => {
      const cursor = after === undefined ? undefined : this.rowFor(after)
      if (after !== undefined && cursor === undefined) return undefined
      const bindings: SqlStorageValue[] = []
      const where = cursor === undefined
        ? ''
        : 'WHERE (s.created_at < ? OR (s.created_at = ? AND s.id > ?))'
      if (cursor !== undefined) bindings.push(cursor.created_at, cursor.created_at, cursor.id)
      bindings.push(limit + 1)
      const rows = this.storage.sql.exec<SessionSummaryRow>(
        `${SESSION_SUMMARY_MATERIALIZED} ${where}
         ORDER BY s.created_at DESC, s.id ASC LIMIT ?`,
        ...bindings,
      ).toArray()
      return {
        sessions: rows.slice(0, limit).map(rowToStoredSessionSummary),
        hasMore: rows.length > limit,
      }
    })
  }

  /** Read the upstream session-list baseline ordered by human activity. */
  readAllSessionSummaries(): EdgeStoredSessionSummary[] {
    return this.storage.sql.exec<SessionSummaryRow>(
      `${SESSION_SUMMARY_MATERIALIZED}
       ORDER BY coalesce(sm.last_prompt_at, s.created_at) DESC, s.id ASC`,
    ).toArray().map(rowToStoredSessionSummary)
  }

  /** Read only the newest canonical summaries needed by bounded consumers. */
  readRecentSessionSummaries(limit: number): EdgeStoredSessionSummary[] {
    return this.storage.sql.exec<SessionSummaryRow>(
      `${SESSION_SUMMARY_MATERIALIZED}
       ORDER BY coalesce(sm.last_prompt_at, s.created_at) DESC, s.id ASC LIMIT ?`,
      limit,
    ).toArray().map(rowToStoredSessionSummary)
  }

  private initialize(): string {
    this.storage.sql.exec('PRAGMA foreign_keys = ON')
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_session_persistence_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        store_id TEXT NOT NULL
      ) STRICT`)
      const state = this.storage.sql.exec<StateRow>(
        'SELECT schema_version, store_id FROM dsh_session_persistence_state WHERE singleton = 1',
      ).toArray()[0]
      if (state !== undefined && state.schema_version !== DO_SESSION_SCHEMA_VERSION) {
        throw new Error(
          `dsh-edge session schema ${state.schema_version} is incompatible with ${DO_SESSION_SCHEMA_VERSION}`,
        )
      }
      if (state !== undefined && state.store_id.length === 0) {
        throw new Error('dsh-edge session persistence has no valid store identity')
      }
      if (state === undefined) this.removePreCanonicalPrototype()
      const storeId = state?.store_id ?? crypto.randomUUID()
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO dsh_session_persistence_state
          (singleton, schema_version, store_id) VALUES (1, ?, ?)`,
        DO_SESSION_SCHEMA_VERSION,
        storeId,
      )
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_sessions (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        cwd TEXT,
        parent_session TEXT,
        seed_length INTEGER,
        origin TEXT,
        delegation_depth INTEGER,
        agent_preset TEXT,
        incarnation TEXT NOT NULL,
        revision INTEGER NOT NULL
      ) STRICT`)
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_session_events (
        session_id TEXT NOT NULL REFERENCES dsh_sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        time INTEGER NOT NULL,
        data TEXT NOT NULL,
        source_event_seqs TEXT,
        surface_op TEXT,
        ignorable INTEGER,
        PRIMARY KEY (session_id, seq)
      ) STRICT`)
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_edge_blank_sessions (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        cwd TEXT,
        parent_session TEXT,
        seed_length INTEGER,
        origin TEXT,
        delegation_depth INTEGER,
        agent_preset TEXT
      ) STRICT`)
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_session_summaries (
        session_id TEXT PRIMARY KEY REFERENCES dsh_sessions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_prompt_at INTEGER,
        last_seq INTEGER NOT NULL,
        blank INTEGER NOT NULL,
        title_seq INTEGER,
        title_time INTEGER,
        title_data TEXT
      ) STRICT`)
      this.syncSummaries()
      this.repackExistingChunks()
      return `durable-object:store:${storeId}`
    })
  }

  private repackExistingChunks(): void {
    const candidates = this.storage.sql.exec<{ id: string }>(
      `SELECT DISTINCT session_id AS id FROM dsh_session_events
       WHERE type = 'assistant/chunk' LIMIT 5`,
    ).toArray()
    for (const candidate of candidates) {
      try {
        this.repackOneSession(candidate.id as SessionId)
      } catch {
        // Torn tail or unparsable events — skip this session, loadStored will repair it later
      }
    }
  }

  private repackOneSession(id: SessionId): void {
    const rows = this.storage.sql.exec<EventRow>(
      `SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
       FROM dsh_session_events WHERE session_id = ? ORDER BY seq`,
      id,
    ).toArray()
    const events = rows.flatMap(row => rowToEvents(row))
    const packed = packChunkRuns(events)
    if (packed.length >= rows.length) {
      // Can't shrink — convert remaining raw chunks to prevent re-selection.
      // Delete only the assistant/chunk rows and re-insert them as-is (they'll
      // keep their type but won't match the LIMIT query after packing converts
      // runs of 3+ into packed rows; isolated chunks stay as-is).
      // Since packChunkRuns already returned the same count, there's nothing
      // to do — mark progress by updating one chunk's type won't help.
      // Instead, just return; the LIMIT 5 loop processes other sessions.
      return
    }
    this.storage.sql.exec(
      'DELETE FROM dsh_session_events WHERE session_id = ?',
      id,
    )
    for (const record of packed) {
      this.insertEvent(id, record as SessionEvent)
    }
  }

  private syncSummaries(): void {
    const stale = this.storage.sql.exec<{ id: string }>(
      `SELECT s.id FROM dsh_sessions s
       LEFT JOIN dsh_session_summaries sm ON s.id = sm.session_id
       WHERE sm.session_id IS NULL OR sm.revision != s.revision`,
    ).toArray()
    for (const row of stale) {
      this.recomputeSummary(row.id as SessionId)
    }
  }

  private recomputeSummary(id: SessionId): void {
    const row = this.storage.sql.exec<SessionSummaryRow>(
      `${SESSION_SUMMARY_SELECT} WHERE s.id = ?`,
      id,
    ).toArray()[0]
    if (row === undefined) return
    this.storage.sql.exec(
      `INSERT INTO dsh_session_summaries
        (session_id, revision, updated_at, last_prompt_at, last_seq, blank,
         title_seq, title_time, title_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         revision = excluded.revision,
         updated_at = excluded.updated_at,
         last_prompt_at = excluded.last_prompt_at,
         last_seq = excluded.last_seq,
         blank = excluded.blank,
         title_seq = excluded.title_seq,
         title_time = excluded.title_time,
         title_data = excluded.title_data`,
      id,
      row.revision,
      row.updated_at ?? row.created_at,
      row.last_prompt_at,
      row.last_seq ?? -1,
      row.blank ? 1 : 0,
      row.title_seq,
      row.title_time,
      row.title_data,
    )
  }

  private updateSummaryFromBatch(id: SessionId, events: readonly SessionEvent[]): void {
    const lastEvent = events.at(-1)
    if (lastEvent === undefined) return
    const existing = this.storage.sql.exec<{
      blank: number
      last_prompt_at: number | null
      title_seq: number | null
      title_time: number | null
      title_data: string | null
    }>(
      `SELECT blank, last_prompt_at, title_seq, title_time, title_data
       FROM dsh_session_summaries WHERE session_id = ?`,
      id,
    ).toArray()[0]

    let blank = existing?.blank ?? 1
    let lastPromptAt: number | null = existing?.last_prompt_at ?? null
    let titleSeq: number | null = existing?.title_seq ?? null
    let titleTime: number | null = existing?.title_time ?? null
    let titleData: string | null = existing?.title_data ?? null

    for (const event of events) {
      if (event.type === 'turn/start') blank = 0
      if (event.type === 'user/message') {
        const data = event.data as unknown as Record<string, unknown>
        const source = data.source as Record<string, unknown> | undefined
        if (source?.kind === 'user') lastPromptAt = event.time
      }
      if (event.type === 'session/title') {
        titleSeq = event.seq
        titleTime = event.time
        titleData = JSON.stringify(event.data)
      }
    }

    const rev = this.storage.sql.exec<{ revision: number }>(
      'SELECT revision FROM dsh_sessions WHERE id = ?',
      id,
    ).toArray()[0]?.revision ?? 0

    this.storage.sql.exec(
      `INSERT INTO dsh_session_summaries
        (session_id, revision, updated_at, last_prompt_at, last_seq, blank,
         title_seq, title_time, title_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         revision = excluded.revision,
         updated_at = excluded.updated_at,
         last_prompt_at = excluded.last_prompt_at,
         last_seq = excluded.last_seq,
         blank = excluded.blank,
         title_seq = excluded.title_seq,
         title_time = excluded.title_time,
         title_data = excluded.title_data`,
      id,
      rev,
      lastEvent.time,
      lastPromptAt,
      lastEvent.seq,
      blank,
      titleSeq,
      titleTime,
      titleData,
    )
  }

  private insertEmptyLogSummary(id: SessionId, createdAt: number): void {
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO dsh_session_summaries
        (session_id, revision, updated_at, last_prompt_at, last_seq, blank,
         title_seq, title_time, title_data)
       VALUES (?, 0, ?, NULL, -1, 1, NULL, NULL, NULL)`,
      id,
      createdAt,
    )
  }

  private removePreCanonicalPrototype(): void {
    this.storage.sql.exec('DROP TABLE IF EXISTS dsh_session_events')
    this.storage.sql.exec('DROP TABLE IF EXISTS dsh_sessions')
    this.storage.sql.exec('DROP TABLE IF EXISTS dsh_edge_events')
    this.storage.sql.exec('DROP TABLE IF EXISTS dsh_edge_messages')
    this.storage.sql.exec('DROP TABLE IF EXISTS dsh_edge_turns')
    this.storage.sql.exec('DROP TABLE IF EXISTS dsh_edge_session_metadata')
    this.storage.sql.exec('DROP TABLE IF EXISTS dsh_edge_sessions')
  }

  private rowFor(id: SessionId): HeaderRow | undefined {
    return this.storage.sql.exec<HeaderRow>(
      `SELECT id, version, created_at, cwd, parent_session, seed_length, origin,
              delegation_depth, agent_preset, incarnation, revision
       FROM dsh_sessions WHERE id = ?`,
      id,
    ).toArray()[0]
  }

  private eventRows(id: SessionId, fromSeq: number): EventRow[] {
    const startSeq = fromSeq === 0 ? 0 : (this.storage.sql.exec<{ seq: number }>(
      `SELECT MAX(seq) AS seq FROM dsh_session_events
       WHERE session_id = ? AND seq <= ?`,
      id,
      fromSeq,
    ).toArray()[0]?.seq ?? fromSeq)
    return this.storage.sql.exec<EventRow>(
      `SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
       FROM dsh_session_events
       WHERE session_id = ? AND seq >= ? ORDER BY seq`,
      id,
      startSeq,
    ).toArray()
  }

  private eventRowRangeContaining(
    id: SessionId,
    fromSeq: number,
    limit: number,
    toSeqExclusive?: number,
  ): EventRow[] {
    const startSeq = this.storage.sql.exec<{ seq: number }>(
      `SELECT MAX(seq) AS seq FROM dsh_session_events
       WHERE session_id = ? AND seq <= ?`,
      id,
      fromSeq,
    ).toArray()[0]?.seq ?? fromSeq
    const sqlLimit = limit + 1
    if (toSeqExclusive !== undefined) {
      return this.storage.sql.exec<EventRow>(
        `SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
         FROM dsh_session_events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq LIMIT ?`,
        id,
        startSeq,
        toSeqExclusive,
        sqlLimit,
      ).toArray()
    }
    return this.storage.sql.exec<EventRow>(
      `SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
       FROM dsh_session_events WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
      id,
      startSeq,
      sqlLimit,
    ).toArray()
  }

  /** Find the newest parseable commit marker without materializing marker rows. */
  private lastCommittedSequence(id: SessionId): number {
    return this.storage.sql.exec<LastSequenceRow>(
      `SELECT MAX(seq) AS seq FROM dsh_session_events
       WHERE session_id = ? AND type = 'turn/end'
         AND json_valid(data)
         AND (source_event_seqs IS NULL OR json_valid(source_event_seqs))
         AND (surface_op IS NULL OR json_valid(surface_op))`,
      id,
    ).toArray()[0]?.seq ?? -1
  }

  private writeRow(meta: SessionHeader): void {
    this.storage.sql.exec(
      `INSERT INTO dsh_sessions
        (id, version, created_at, cwd, parent_session, seed_length, origin,
         delegation_depth, agent_preset, incarnation, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version,
         created_at = excluded.created_at,
         cwd = excluded.cwd,
         parent_session = excluded.parent_session,
         seed_length = excluded.seed_length,
         origin = excluded.origin,
         delegation_depth = excluded.delegation_depth,
         agent_preset = excluded.agent_preset`,
      meta.id,
      meta.version,
      meta.createdAt,
      meta.cwd ?? null,
      meta.parentSession ?? null,
      meta.seedLength ?? null,
      meta.origin ?? null,
      meta.delegationDepth ?? null,
      meta.agentPreset ?? null,
      crypto.randomUUID(),
    )
  }

  private insertEvent(id: SessionId, event: SessionEvent): void {
    const envelope = event as SessionEvent & {
      sourceEventSeqs?: number[]
      surfaceOp?: SurfaceOp
    }
    this.storage.sql.exec(
      `INSERT INTO dsh_session_events
        (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      event.seq,
      event.type,
      event.time,
      JSON.stringify(event.data),
      envelope.sourceEventSeqs === undefined ? null : JSON.stringify(envelope.sourceEventSeqs),
      envelope.surfaceOp === undefined ? null : JSON.stringify(envelope.surfaceOp),
      event.ignorable === true ? 1 : null,
    )
  }

}

function revisionOf(storeIdentity: string, row: HeaderRow): PersistenceRevision {
  return SessionPersistenceRevision(
    `${storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`,
  )
}

/** Convert the DO's synchronous SQL surface into the backend's Promise contract. */
function promiseFromSync<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation())
  } catch (error) {
    // Preserve the exact synchronous rejection value, including AbortSignal.reason.
    const deferred = Promise.withResolvers<T>()
    deferred.reject(error)
    return deferred.promise
  }
}

function rowToHeader(row: HeaderRow): SessionHeader {
  if (!Number.isSafeInteger(row.created_at) || row.created_at < 0) {
    throw new Error('stored session createdAt must be a non-negative safe integer')
  }
  return {
    id: row.id as SessionId,
    version: row.version,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    ...row.seed_length === null ? {} : { seedLength: row.seed_length },
    ...row.origin === null ? {} : { origin: row.origin as 'subagent' },
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function blankRowToHeader(row: BlankSessionRow): SessionHeader {
  const header = rowToHeader({ ...row, incarnation: '', revision: 0 })
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new SessionFormatUnsupportedError(
      sessionFormatVersionRefusal(header.id, header.version),
    )
  }
  return header
}

function rowToEvents(row: EventRow): SessionEvent[] {
  const record = {
    type: row.type,
    seq: row.seq,
    time: row.time,
    data: JSON.parse(row.data) as SessionEvent['data'],
    ...row.source_event_seqs === null
      ? {}
      : { sourceEventSeqs: JSON.parse(row.source_event_seqs) as number[] },
    ...row.surface_op === null
      ? {}
      : { surfaceOp: JSON.parse(row.surface_op) as SurfaceOp },
    ...row.ignorable === 1 ? { ignorable: true as const } : {},
  }
  return decodeStorageRecord(record) as SessionEvent[]
}

function historyGroupStart(row: HistoryBoundaryRow): number {
  if (row.source_event_seqs === null) return row.seq
  let sources: unknown
  try {
    sources = JSON.parse(row.source_event_seqs)
  } catch {
    return row.seq
  }
  if (!Array.isArray(sources) || !sources.every(value => Number.isSafeInteger(value))) {
    return row.seq
  }
  return (sources as number[]).reduce((minimum, value) => Math.min(minimum, value), row.seq)
}

function rowToStoredSessionSummary(row: SessionSummaryRow): EdgeStoredSessionSummary {
  const meta = rowToHeader(row)
  if (meta.version !== SESSION_FORMAT_VERSION) {
    throw new SessionFormatUnsupportedError(
      sessionFormatVersionRefusal(meta.id, meta.version),
    )
  }
  const updatedAt = row.updated_at ?? meta.createdAt
  if (!Number.isSafeInteger(updatedAt)) {
    throw new Error(`stored session ${meta.id} has an invalid latest event time`)
  }
  if (row.last_prompt_at !== null && !Number.isSafeInteger(row.last_prompt_at)) {
    throw new Error(`stored session ${meta.id} has an invalid latest prompt time`)
  }
  const lastSeq = row.last_seq ?? -1
  if (!Number.isSafeInteger(lastSeq) || lastSeq < -1) {
    throw new Error(`stored session ${meta.id} has an invalid latest event sequence`)
  }
  if (row.blank !== 0 && row.blank !== 1) {
    throw new Error(`stored session ${meta.id} has an invalid blank-session marker`)
  }
  const base = {
    meta,
    updatedAt,
    lastPromptAt: row.last_prompt_at,
    lastSeq,
    blank: row.blank === 1,
  }
  const titleFields = [row.title_seq, row.title_time, row.title_data]
  if (titleFields.every(value => value === null)) return base
  if (row.title_seq === null || row.title_time === null || row.title_data === null) {
    throw new Error(`stored session ${meta.id} has an incomplete title event`)
  }
  return {
    ...base,
    titleEvent: storedTitleEvent(meta.id, row.title_seq, row.title_time, row.title_data),
  }
}

/** Validate the upstream session-title shape at the abbreviated durable read boundary. */
function storedTitleEvent(
  id: SessionId,
  seq: number,
  time: number,
  rawData: string,
): SessionEvent<'session/title'> {
  if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(time)) {
    throw new Error(`stored session ${id} has an invalid session/title envelope`)
  }
  let data: unknown
  try {
    data = JSON.parse(rawData)
  } catch {
    throw new Error(`stored session ${id} has unparsable session/title data`)
  }
  const validated = sessionTitleEventData(data)
  if (validated === undefined) {
    throw new Error(`stored session ${id} has invalid session/title data`)
  }
  return { type: 'session/title', seq, time, data: validated }
}

function sessionTitleEventData(value: unknown): SessionTitleEventData | undefined {
  if (!hasOnlyKeys(value, ['title', 'messageSeqs', 'source'])) return undefined
  if (typeof value.title !== 'string' || value.title.length === 0) return undefined
  if (!isSessionTitleMessageSeqs(value.messageSeqs)) return undefined
  const source = sessionTitleSource(value.source)
  if (source === undefined) return undefined
  return { title: value.title, messageSeqs: [...value.messageSeqs], source }
}

function sessionTitleSource(value: unknown): SessionTitleSource | undefined {
  if (!hasOnlyKeys(value, ['kind'], ['provider', 'model'])) return undefined
  switch (value.kind) {
    case 'fallback':
    case 'user':
      return Object.keys(value).length === 1 ? { kind: value.kind } : undefined
    case 'provider': {
      if (typeof value.provider !== 'string' || value.provider.length === 0) return undefined
      if (value.model === undefined) {
        return { kind: 'provider', provider: SessionTitleProviderId(value.provider) }
      }
      if (!hasOnlyKeys(value.model, ['provider', 'model'])
        || typeof value.model.provider !== 'string'
        || value.model.provider.length === 0
        || typeof value.model.model !== 'string'
        || value.model.model.length === 0) return undefined
      return {
        kind: 'provider',
        provider: SessionTitleProviderId(value.provider),
        model: { provider: value.model.provider, model: value.model.model },
      }
    }
    default:
      return undefined
  }
}

function isSessionTitleMessageSeqs(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.every((seq: unknown) => typeof seq === 'number'
      && Number.isSafeInteger(seq)
      && seq >= 0)
}

/** Validate only the upstream request-routing fields this abbreviated projection consumes. */
function requestHeaderConfig(value: unknown): EdgeStoredModelSelection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const header = (value as Record<string, unknown>)['header']
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return undefined
  const config = (header as Record<string, unknown>)['config']
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return undefined
  const fields = config as Record<string, unknown>
  if (typeof fields['provider'] !== 'string' || fields['provider'].length === 0) return undefined
  if (typeof fields['model'] !== 'string' || fields['model'].length === 0) return undefined
  const reasoningEffort = fields['reasoningEffort']
  if (reasoningEffort !== undefined
    && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) return undefined
  return {
    provider: fields['provider'],
    model: fields['model'],
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

function hasOnlyKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => required.includes(key) || optional.includes(key))
}

/** Preserve the valid contiguous prefix and identify a never-committed torn tail. */
function scanRows(
  rows: readonly EventRow[],
  base = 0,
  committedThrough?: number,
): { preserved: SessionEvent[]; tornFrom?: number } {
  const decoded: Array<{ ok: true; events: SessionEvent[] } | { ok: false }> = rows.map((row) => {
    try {
      return { ok: true as const, events: rowToEvents(row) }
    } catch {
      return { ok: false as const }
    }
  })
  let lastTurnEnd = committedThrough
  if (lastTurnEnd === undefined) {
    lastTurnEnd = -1
    for (let index = decoded.length - 1; index >= 0; index -= 1) {
      if (decoded[index]?.ok === true && rows[index]?.type === 'turn/end') {
        lastTurnEnd = rows[index]?.seq ?? -1
        break
      }
    }
  }
  const preserved: SessionEvent[] = []
  let nextSeq = base
  let rowsConsumed = 0
  for (let index = 0; index < rows.length; index += 1) {
    const candidate = decoded[index]
    if (candidate?.ok !== true) {
      if ((rows[index]?.seq ?? nextSeq) <= lastTurnEnd) {
        throw new Error(`corrupt session log: unparsable committed event at seq ${rows[index]?.seq}`)
      }
      break
    }
    const filtered = candidate.events.filter(e => e.seq >= base)
    const firstSeq = filtered[0]?.seq ?? nextSeq
    if (firstSeq !== nextSeq) {
      if (firstSeq <= lastTurnEnd) {
        throw new Error(
          `corrupt session log: seq gap in committed region (expected ${nextSeq}, got ${firstSeq})`,
        )
      }
      break
    }
    preserved.push(...filtered)
    nextSeq = (candidate.events[0]?.seq ?? nextSeq) + candidate.events.length
    rowsConsumed++
  }
  return rowsConsumed < rows.length
    ? { preserved, tornFrom: base + preserved.length }
    : { preserved }
}

export default DurableObjectSessionPersistence
