/**
 * Edge-owned Host Schedule service behind the upstream `ctx.schedule` seam.
 *
 * Upstream 0.2.0 moved reminders out of Session events into a Host-wide task
 * table whose runtime delivers with a process timer and a direct Agent
 * follow-up. The Edge keeps the upstream tools (`dsh-tool-schedule`) and pure
 * schedule rules, stores tasks in Durable Object SQLite, and delivers through
 * its own alarm and main session queue so reminders share admission, ordering,
 * and cancellation with user input.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import {
  createAfterScheduleRecord, createAtScheduleRecord, createEveryScheduleRecord,
  createDailyScheduleRecord, createWeeklyScheduleRecord, createCronScheduleRecord, decodeScheduleRecord,
  isRecurringScheduleRecord, renderReminderFraming, renderRecurringReminderBatchFraming, resolveRecurringOccurrence,
  scheduleTitle, ScheduleId, ScheduleInputError, ScheduleLogError, MAX_TITLE_LENGTH,
  type ScheduleRecord, type ScheduleCreateRequest, type ScheduleListRequest, type ScheduleCatalogEntry,
  type ScheduleDeleteRequest, type ScheduleDeleteResult, type ScheduleUpdateRequest, type ScheduleUpdateResult,
  type ScheduleTimingChange, type ScheduleDeliveryHistoryRequest, type ScheduleDeliveryHistoryResult,
  type ScheduleDeliveryReceipt, type ScheduleDeliveryRecord, type DeliveryRetentionBounds,
} from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { insertMainInput, MainQueueFullError, MAIN_WAKE_MS } from './main-session-queue.ts'
import type {} from './upstream-message-sources.ts'

const MAX_ACTIVE_SCHEDULES = 128
const MAX_ENDED_SCHEDULES = 128
const MAX_PROMPT_BYTES = 4096
/**
 * Upstream's default delivery-history retention per task: the newest 200
 * records within 30 days of the latest delivery. At most 256 tasks are kept
 * (128 active, 128 ended), so the history holds at most 51,200 rows.
 */
const DELIVERY_RETENTION: DeliveryRetentionBounds = { days: 30, records: 200 }
const DAY_MS = 86_400_000
const MAX_HISTORY_PAGE = 100

interface TaskRow extends Record<string, SqlStorageValue> {
  id: string
  session_id: string
  record: string
  active: number
  delivery: string | null
}

/**
 * A task's delivery summary, kept on its row so a delivery adds no write there:
 * the latest receipt and upstream's two history flags. A task stored before
 * delivery history existed has none (`NULL`), which reads as upstream reads a
 * task without saved history: earlier records unavailable, none pruned.
 */
interface DeliverySummary {
  readonly last?: ScheduleDeliveryReceipt
  readonly earlierUnavailable: boolean
  readonly earlierPruned: boolean
}

const NEW_TASK_DELIVERY = JSON.stringify({ earlierUnavailable: false, earlierPruned: false } satisfies DeliverySummary)

/**
 * The Edge schedule service; tools reach it as `ctx.schedule`, and the Web task
 * page through upstream's `schedule` Remote namespace, whose registered
 * descriptors the gateway calls on this service by its `typertRemote` binding.
 */
export class EdgeSchedule extends TypertRemoteService {
  static inject = ['agents', 'tools']
  private readonly storage: DurableObjectStorage

  constructor(ctx: Context, config: { storage: DurableObjectStorage }) {
    super(ctx, 'schedule')
    this.storage = config.storage
    initializeSchedules(this.storage)
    // An idle Session with armed reminders refuses archive; an archiving stop
    // removes them instead of delivering into a closed Session.
    ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      const active = await this.list({ sessionId })
      const rest = await next()
      if (active.length === 0) return rest
      return [{ kind: 'schedule', items: active.map(record => ({ id: record.id, label: record.title })) }, ...rest]
    })
    ctx.on('workspace/session-stop', ({ sessionId }) => {
      const stopped = this.storage.transactionSync(() => {
        const ids = this.storage.sql.exec<{ id: string }>('SELECT id FROM dsh_schedule_tasks WHERE session_id = ? AND active = 1', sessionId).toArray()
        for (const { id } of ids) deleteTask(this.storage, sessionId, id)
        pruneScheduleRetry(this.storage, sessionId)
        return ids.length > 0
      })
      if (stopped) this.changed()
    })
  }

  /**
   * Tell the Web clients the task set changed (upstream's `schedule/changed`,
   * which the gateway forwards), after the change committed. A failing
   * listener must not fail the change that already landed.
   */
  changed(): void {
    try {
      this.ctx.emit('schedule/changed')
    } catch (error) {
      console.error('dsh-edge: a schedule/changed listener failed.', error)
    }
  }

  async create(sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord> {
    const selectors = [request.at, request.after_seconds, request.every_seconds, request.daily, request.weekly, request.cron]
    if (selectors.filter(value => value !== undefined).length !== 1) {
      throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    }
    assertPromptBudget(request.prompt)
    const title = scheduleTitle(request.title)
    const id = ScheduleId(`schedule-${crypto.randomUUID()}`)
    const now = Date.now()
    const record = request.at !== undefined ? createAtScheduleRecord(id, request.prompt, request.at, now, title)
      : request.after_seconds !== undefined ? createAfterScheduleRecord(id, request.prompt, request.after_seconds, now, title)
        : request.every_seconds !== undefined ? createEveryScheduleRecord(id, request.prompt, request.every_seconds, now, title)
          : request.daily !== undefined ? createDailyScheduleRecord(id, request.prompt, request.daily, now, title)
            : request.weekly !== undefined ? createWeeklyScheduleRecord(id, request.prompt, request.weekly, now, title)
              : createCronScheduleRecord(id, request.prompt, request.cron!, now, title)
    signal?.throwIfAborted()
    // The task and its wake commit together: a failed arm leaves no reminder behind.
    await this.storage.transaction(async () => {
      const active = this.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM dsh_schedule_tasks WHERE active = 1').toArray()[0]!.count
      if (active >= MAX_ACTIVE_SCHEDULES) {
        throw new ScheduleInputError('invalid_rule', `This owner already has ${MAX_ACTIVE_SCHEDULES} active reminders; delete one before creating another.`)
      }
      this.storage.sql.exec('INSERT INTO dsh_schedule_tasks (id,session_id,record,active,due,created,delivery) VALUES (?,?,?,1,?,?,?)',
        id, sessionId, JSON.stringify(record), Date.parse(record.scheduledAt), now, NEW_TASK_DELIVERY)
      await armScheduleWake(this.storage)
    })
    this.changed()
    return record
  }

  async list(request: ScheduleListRequest): Promise<ScheduleRecord[]> {
    return this.rows('WHERE session_id = ? AND active = 1 ORDER BY created, id', request.sessionId).map(recordOf)
  }

  async catalog(): Promise<ScheduleCatalogEntry[]> {
    return this.rows('ORDER BY created, id').map((row) => {
      const last = summaryOf(row).last
      return {
        ...recordOf(row), sessionId: row.session_id as SessionId, status: row.active === 1 ? 'active' as const : 'inactive' as const,
        ...last === undefined ? {} : { lastDelivery: last },
      }
    }).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
  }

  /**
   * One task's saved deliveries, newest first, `limit` at a time, as upstream
   * pages them: `before` is the message id of the oldest record of the previous
   * page, and `nextBefore` is present only while older records remain.
   */
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_HISTORY_PAGE) {
      throw new ScheduleInputError('invalid_rule', `limit must be a safe integer from 1 through ${String(MAX_HISTORY_PAGE)}.`)
    }
    const row = this.rows('WHERE id = ? AND session_id = ?', request.id, request.sessionId)[0]
    if (row === undefined) return { id: request.id, code: 'schedule_not_found' }
    let before = Number.MAX_SAFE_INTEGER
    if (request.before !== undefined) {
      const cursor = this.storage.sql.exec<{ seq: number }>(
        'SELECT seq FROM dsh_schedule_deliveries WHERE session_id = ? AND task_id = ? AND message_id = ?',
        request.sessionId, request.id, request.before).toArray()[0]
      if (cursor === undefined) return { id: request.id, code: 'delivery_cursor_not_found' }
      before = cursor.seq
    }
    const rows = this.storage.sql.exec<DeliveryRow>(
      `SELECT message_id, scheduled_at, delivered_at, prompt FROM dsh_schedule_deliveries
       WHERE session_id = ? AND task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
      request.sessionId, request.id, before, request.limit + 1).toArray()
    const records = rows.slice(0, request.limit).map(deliveryRecordOf)
    const summary = summaryOf(row)
    return {
      id: request.id,
      records,
      earlierRecordsUnavailable: summary.earlierUnavailable,
      earlierRecordsPruned: summary.earlierPruned,
      retention: { ...DELIVERY_RETENTION },
      ...rows.length > request.limit ? { nextBefore: records.at(-1)!.messageId } : {},
    }
  }

  async delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult> {
    signal?.throwIfAborted()
    const deleted = this.storage.transactionSync(() => {
      if (!deleteTask(this.storage, request.sessionId, request.id)) return false
      pruneScheduleRetry(this.storage, request.sessionId)
      return true
    })
    if (!deleted) return { id: request.id, deleted: false, code: 'schedule_not_found' }
    this.changed()
    return { id: request.id, deleted: true }
  }

  async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult> {
    signal?.throwIfAborted()
    // Read, check `expected`, and write in one transaction, so an overlapping
    // update or delete yields a conflict or not-found instead of a lost write.
    const result = await this.storage.transaction(async () => {
      const row = this.rows('WHERE id = ? AND session_id = ?', request.id, request.sessionId)[0]
      if (row === undefined) return { id: request.id, updated: false, code: 'schedule_not_found' } as const
      if (row.active !== 1) return { id: request.id, updated: false, code: 'schedule_ended' } as const
      const result = resolveScheduleUpdate(recordOf(row), request, Date.now())
      if (!('record' in result) || !result.updated) return result
      this.storage.sql.exec('UPDATE dsh_schedule_tasks SET record = ?, due = ? WHERE session_id = ? AND id = ?',
        JSON.stringify(result.record), Date.parse(result.record.scheduledAt), request.sessionId, request.id)
      await armScheduleWake(this.storage)
      return result
    })
    if ('updated' in result && result.updated) this.changed()
    return result
  }

  private rows(clause: string, ...bindings: SqlStorageValue[]): TaskRow[] {
    return this.storage.sql.exec<TaskRow>(`SELECT id, session_id, record, active, delivery FROM dsh_schedule_tasks ${clause}`, ...bindings).toArray()
  }
}

interface DeliveryRow extends Record<string, SqlStorageValue> {
  message_id: string
  scheduled_at: string
  delivered_at: string
  prompt: string
}

function deliveryRecordOf(row: DeliveryRow): ScheduleDeliveryRecord {
  return {
    scheduledAt: row.scheduled_at, deliveredAt: row.delivered_at, messageId: row.message_id as ScheduleDeliveryRecord['messageId'], prompt: row.prompt,
  }
}

function summaryOf(row: Pick<TaskRow, 'delivery'>): DeliverySummary {
  return row.delivery === null ? { earlierUnavailable: true, earlierPruned: false } : JSON.parse(row.delivery) as DeliverySummary
}

/** Remove one task and its saved deliveries; false when the session has no such task. */
function deleteTask(storage: DurableObjectStorage, sessionId: string, id: string): boolean {
  if (storage.sql.exec('DELETE FROM dsh_schedule_tasks WHERE session_id = ? AND id = ?', sessionId, id).rowsWritten === 0) return false
  storage.sql.exec('DELETE FROM dsh_schedule_deliveries WHERE session_id = ? AND task_id = ?', sessionId, id)
  return true
}

/**
 * Save one delivery of a task and keep its history within the retention
 * bounds, in the dispatch transaction that queued the message.
 * @returns The task's new delivery summary, for the task update dispatch already makes.
 */
function recordDelivery(storage: DurableObjectStorage, sessionId: string, row: TaskRow, receipt: ScheduleDeliveryReceipt, prompt: string): string {
  const last = storage.sql.exec<{ seq: number | null }>(
    'SELECT MAX(seq) AS seq FROM dsh_schedule_deliveries WHERE session_id = ? AND task_id = ?', sessionId, row.id).toArray()[0]?.seq ?? null
  const seq = (last ?? -1) + 1
  storage.sql.exec(`INSERT INTO dsh_schedule_deliveries (session_id,task_id,seq,message_id,scheduled_at,delivered_at,prompt)
    VALUES (?,?,?,?,?,?,?)`, sessionId, row.id, seq, receipt.messageId, receipt.scheduledAt, receipt.deliveredAt, prompt)
  const floor = new Date(Date.parse(receipt.deliveredAt) - DELIVERY_RETENTION.days * DAY_MS).toISOString()
  const pruned = storage.sql.exec(`DELETE FROM dsh_schedule_deliveries WHERE session_id = ? AND task_id = ?
    AND (seq <= ? OR delivered_at < ?)`, sessionId, row.id, seq - DELIVERY_RETENTION.records, floor).rowsWritten > 0
  const summary = summaryOf(row)
  return JSON.stringify({
    last: receipt,
    earlierUnavailable: summary.earlierUnavailable || pruned,
    earlierPruned: summary.earlierPruned || pruned,
  } satisfies DeliverySummary)
}

function assertPromptBudget(prompt: string): void {
  if (new TextEncoder().encode(JSON.stringify(prompt)).byteLength > MAX_PROMPT_BYTES) {
    throw new ScheduleInputError('invalid_prompt', 'Reminder prompt exceeds the 4 KiB JSON budget.')
  }
}

/** Upstream update semantics: compare the observed record, keep the target when the rule is unchanged. */
function resolveScheduleUpdate(current: ScheduleRecord, request: ScheduleUpdateRequest, now: number): ScheduleUpdateResult {
  let expected: ScheduleRecord
  try {
    expected = decodeScheduleRecord(request.expected)
  } catch (error) {
    if (!(error instanceof ScheduleLogError)) throw error
    return { code: 'invalid_rule', message: 'expected must be a complete valid Schedule record.' }
  }
  if (!deepEqualJson(expected, current)) return { id: current.id, updated: false, code: 'schedule_conflict' }
  try {
    const title = request.title === undefined ? current.title : scheduleTitle(request.title)
    if (request.prompt !== undefined && (typeof request.prompt !== 'string' || request.prompt.trim().length === 0)) {
      throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
    }
    const prompt = request.prompt === undefined ? current.prompt : request.prompt.trim()
    assertPromptBudget(prompt)
    const kept = { ...current, title, prompt }
    const next = request.change === undefined ? kept : retimed(current, title, prompt, request.change, now)
    const record = request.change !== undefined && sameRule(current, next) ? kept : next
    return { id: current.id, updated: !deepEqualJson(record, current), record }
  } catch (error) {
    if (!(error instanceof ScheduleInputError)) throw error
    return { code: error.code, message: error.message }
  }
}

const TIMING_SELECTORS = { at: 'at', every: 'every_seconds', daily: 'daily', weekly: 'weekly', cron: 'cron' } as const

function retimed(current: ScheduleRecord, title: string, prompt: string, change: ScheduleTimingChange, now: number): ScheduleRecord {
  const selector = typeof change === 'object' && change !== null ? TIMING_SELECTORS[change.kind] as string | undefined : undefined
  const keys = selector === undefined ? [] : Object.keys(change)
  if (selector === undefined || keys.length !== 2 || !keys.includes('kind') || !keys.includes(selector)) {
    throw new ScheduleInputError('invalid_rule', 'Timing change must contain exactly kind and its matching timing selector.')
  }
  switch (change.kind) {
    case 'at': return createAtScheduleRecord(current.id, prompt, change.at, now, title)
    case 'every': return createEveryScheduleRecord(current.id, prompt, change.every_seconds, now, title)
    case 'daily': return createDailyScheduleRecord(current.id, prompt, change.daily, now, title)
    case 'weekly': return createWeeklyScheduleRecord(current.id, prompt, change.weekly, now, title)
    case 'cron': return createCronScheduleRecord(current.id, prompt, change.cron, now, title)
  }
}

/** Normalized rule fields only; an absolute one-shot keeps its target when the instant is unchanged. */
function sameRule(current: ScheduleRecord, next: ScheduleRecord): boolean {
  if (next.kind === 'at') return (current.kind === 'at' || current.kind === 'after') && current.scheduledAt === next.scheduledAt
  const rule = ({ id: _id, title: _title, prompt: _prompt, scheduledAt: _at, ...fields }: ScheduleRecord) => fields
  return deepEqualJson(rule(current), rule(next))
}

function recordOf(row: TaskRow): ScheduleRecord {
  return decodeScheduleRecord(JSON.parse(row.record) as unknown)
}

/** Records written before titles existed get a name from their first prompt line. */
function legacyTitle(prompt: string): string {
  const line = prompt.trim().split('\n', 1)[0]!.trim()
  return line.slice(0, MAX_TITLE_LENGTH).trimEnd() || 'Reminder'
}

export function initializeSchedules(storage: DurableObjectStorage): void {
  // Earlier releases numbered reminders per session, so an id is unique only within its session.
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_schedule_tasks (
    session_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
    active INTEGER NOT NULL, due INTEGER NOT NULL, created INTEGER NOT NULL, delivery TEXT,
    PRIMARY KEY(session_id, id))`)
  // A table from before delivery history gains the summary column; its tasks keep NULL (see DeliverySummary).
  const hasDelivery = storage.sql.exec<{ count: number }>(
    "SELECT count(*) AS count FROM pragma_table_info('dsh_schedule_tasks') WHERE name = 'delivery'").toArray()[0]!.count
  if (hasDelivery === 0) storage.sql.exec('ALTER TABLE dsh_schedule_tasks ADD COLUMN delivery TEXT')
  // Saved deliveries in append order per task; the key is the table, so a delivery writes one row.
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_schedule_deliveries (
    session_id TEXT NOT NULL, task_id TEXT NOT NULL, seq INTEGER NOT NULL,
    message_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, delivered_at TEXT NOT NULL, prompt TEXT NOT NULL,
    PRIMARY KEY(session_id, task_id, seq)) WITHOUT ROWID`)
  storage.sql.exec('CREATE INDEX IF NOT EXISTS dsh_schedule_tasks_due ON dsh_schedule_tasks(active,due,session_id,created)')
  storage.sql.exec('CREATE INDEX IF NOT EXISTS dsh_schedule_tasks_session ON dsh_schedule_tasks(session_id,active)')
  storage.sql.exec('CREATE TABLE IF NOT EXISTS dsh_schedule_retry (session_id TEXT PRIMARY KEY, retry_at INTEGER NOT NULL)')
  importSessionSchedules(storage)
}

/** One-time import of the reminders earlier releases folded from Session events. */
function importSessionSchedules(storage: DurableObjectStorage): void {
  const legacy = storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'dsh_schedule_active'").toArray()[0]!.count
  if (legacy === 0) return
  storage.transactionSync(() => {
    const rows = storage.sql.exec<{ session_id: string; record: string; created_seq: number }>(
      'SELECT session_id, record, created_seq FROM dsh_schedule_active ORDER BY due, created_seq').toArray()
    for (const row of rows) {
      let record: ScheduleRecord
      try {
        const stored = JSON.parse(row.record) as { prompt: string; title?: string }
        record = decodeScheduleRecord({ ...stored, title: stored.title ?? legacyTitle(stored.prompt) })
      } catch (error) {
        // One unreadable legacy row must not keep the owner's instance from starting.
        console.warn(`dsh-edge: skipped an unreadable legacy reminder in session ${row.session_id}.`, error)
        continue
      }
      storage.sql.exec('INSERT OR IGNORE INTO dsh_schedule_tasks (id,session_id,record,active,due,created) VALUES (?,?,?,1,?,?)',
        record.id, row.session_id, JSON.stringify(record), Date.parse(record.scheduledAt), row.created_seq)
    }
    storage.sql.exec('DROP TABLE dsh_schedule_active')
    storage.sql.exec('DROP TABLE IF EXISTS dsh_runtime_schedule_reservation')
  })
}

/** No history replay on wake or request paths. Paused sessions require explicit user recovery. */
export function nextSchedule(storage: DurableObjectStorage): { sessionId: string; due: number } | undefined {
  const row = storage.sql.exec<{ session_id: string; due: number }>(`SELECT s.session_id, max(s.due,coalesce(b.retry_at,0)) AS due
    FROM dsh_schedule_tasks s LEFT JOIN dsh_runtime_ready r ON r.session_id = s.session_id
    LEFT JOIN dsh_schedule_retry b ON b.session_id = s.session_id
    WHERE s.active = 1 AND coalesce(r.paused,0) != 1 ORDER BY max(s.due,coalesce(b.retry_at,0)),s.session_id,s.created LIMIT 1`).toArray()[0]
  return row === undefined ? undefined : { sessionId: row.session_id, due: row.due }
}

/** Failed admission retains a bounded wake time even when only paused inputs occupy capacity. */
export function scheduleWakeTime(due: number | undefined, busy: boolean, now = Date.now()): number | undefined {
  return due === undefined ? undefined : Math.max(due, now + (busy ? MAIN_WAKE_MS : 1))
}

/** One failed session defers only its own reminders; the deadline survives a DO restart. */
export function setScheduleRetry(storage: DurableObjectStorage, sessionId: string, retryAt: number): void {
  if (retryAt === 0) storage.sql.exec('DELETE FROM dsh_schedule_retry WHERE session_id = ?', sessionId)
  else storage.sql.exec(`INSERT INTO dsh_schedule_retry (session_id,retry_at)
    SELECT ?,? WHERE EXISTS (SELECT 1 FROM dsh_schedule_tasks WHERE session_id = ? AND active = 1)
    ON CONFLICT(session_id) DO UPDATE SET retry_at = excluded.retry_at`, sessionId, retryAt, sessionId)
}

/** Keep retry storage bounded by sessions with active reminders. */
function pruneScheduleRetry(storage: DurableObjectStorage, sessionId: string): void {
  storage.sql.exec(`DELETE FROM dsh_schedule_retry WHERE session_id = ?
    AND NOT EXISTS (SELECT 1 FROM dsh_schedule_tasks WHERE session_id = ? AND active = 1)`, sessionId, sessionId)
}

/**
 * Queue one Session's due reminders as a main input and advance their tasks in
 * one transaction, so a reminder is either queued exactly once or still due.
 * Matches upstream grouping: a due one-shot first, otherwise one batch of every
 * due recurring reminder at its latest occurrence.
 * @returns False when nothing is due or the main queue has no capacity.
 */
export function dispatchDueSchedules(storage: DurableObjectStorage, sessionId: string, now: number): boolean {
  return storage.transactionSync(() => {
    const dueRows = storage.sql.exec<TaskRow>(`SELECT id, session_id, record, active, delivery FROM dsh_schedule_tasks
      WHERE session_id = ? AND active = 1 AND due <= ? ORDER BY due, created`, sessionId, now).toArray()
    const due = dueRows.map(recordOf)
    if (due.length === 0) return false
    const oneShot = due.find(record => !isRecurringScheduleRecord(record))
    const group = oneShot === undefined ? due : [oneShot]
    const occurrences = group.filter(isRecurringScheduleRecord).map(record => ({ record, ...resolveRecurringOccurrence(record, now) }))
    const text = oneShot !== undefined ? renderReminderFraming(oneShot) : renderRecurringReminderBatchFraming(occurrences)
    const id = `schedule:${group[0]!.id}:${Date.parse(group[0]!.scheduledAt)}`
    const message = freezeMessage({ ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'schedule' } }), id: MessageId(id) })
    try {
      insertMainInput(storage, sessionId, id, id, message)
    } catch (error) {
      if (error instanceof MainQueueFullError) return false
      throw error
    }
    // Each delivered task saves the delivery with the update it already gets, as upstream acknowledges
    // a reminder once it is durably in the Session's inbox, which the main queue is.
    const deliveredAt = new Date(now).toISOString()
    const rowOf = (id: string) => dueRows.find(row => row.id === id)!
    if (oneShot !== undefined) {
      const delivery = recordDelivery(storage, sessionId, rowOf(oneShot.id),
        { scheduledAt: oneShot.scheduledAt, deliveredAt, messageId: message.id }, oneShot.prompt)
      storage.sql.exec('UPDATE dsh_schedule_tasks SET active = 0, delivery = ? WHERE session_id = ? AND id = ?', delivery, sessionId, oneShot.id)
    }
    for (const { record, occurrenceAt, nextScheduledAt } of occurrences) {
      const delivery = recordDelivery(storage, sessionId, rowOf(record.id),
        { scheduledAt: occurrenceAt, deliveredAt, messageId: message.id }, record.prompt)
      if (nextScheduledAt === undefined) storage.sql.exec('UPDATE dsh_schedule_tasks SET active = 0, delivery = ? WHERE session_id = ? AND id = ?', delivery, sessionId, record.id)
      else storage.sql.exec('UPDATE dsh_schedule_tasks SET record = ?, due = ?, delivery = ? WHERE session_id = ? AND id = ?',
        JSON.stringify({ ...record, scheduledAt: nextScheduledAt }), Date.parse(nextScheduledAt), delivery, sessionId, record.id)
    }
    // Ended tasks answer `schedule_ended` to updates; only the newest few are kept, with their history.
    const expired = storage.sql.exec<{ session_id: string; id: string }>(
      'SELECT session_id, id FROM dsh_schedule_tasks WHERE active = 0 ORDER BY due DESC LIMIT -1 OFFSET ?', MAX_ENDED_SCHEDULES).toArray()
    for (const task of expired) deleteTask(storage, task.session_id, task.id)
    pruneScheduleRetry(storage, sessionId)
    return true
  })
}

/** Only advance the alarm here; the owner merges/removes all wake sources after driving. */
export async function armScheduleWake(storage: DurableObjectStorage): Promise<void> {
  const next = nextSchedule(storage)
  const pending = storage.sql.exec<{ pending: number }>('SELECT pending FROM dsh_runtime_slot WHERE id = 1').toArray()[0]?.pending ?? 0
  const target = Math.min(next?.due ?? Infinity, pending > 0 ? Date.now() + MAIN_WAKE_MS : Infinity)
  if (!Number.isFinite(target)) return
  const alarm = await storage.getAlarm()
  if (alarm === null || target < alarm) await storage.setAlarm(Math.max(Date.now() + 1, target))
}
