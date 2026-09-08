/** Materialized upstream Schedule records and atomic reminder admission. */
import { createUserMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import {
  registerScheduleTools, foldScheduleEvents, decodeScheduleChange, renderReminderFraming, renderEveryReminderBatchFraming,
  resolveEveryOccurrence, type ScheduleRecord, type ScheduleChange, type EveryScheduleRecord,
} from '@deepseek-ai/dsh-schedule'
import type { SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { insertMainInput, MAIN_WAKE_MS, MAIN_QUEUE_BYTES, MAIN_QUEUE_LIMIT } from './main-session-queue.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MAX_ACTIVE_SCHEDULES = 128
const MAX_PROMPT_BYTES = 4096

/** Reuse the public tools, replacing only host delivery text and Edge resource bounds. */
export function installScheduleTools(ctx: Context, agent: Agent, storage: DurableObjectStorage): () => void {
  const dispose = registerScheduleTools(ctx, agent.ctx, agent, () => {})
  const definitions = ['schedule_create', 'schedule_list', 'schedule_delete'].map(name => {
    const definition = ctx.tools.get(name, agent)
    if (definition === undefined) throw new Error(`Missing upstream ${name}`)
    return definition
  })
  dispose()
  const disposers = definitions.map(definition => agent.ctx.tools.register(definition.name !== 'schedule_create' ? definition : {
    ...definition,
    description: definition.description.replace('the reminder runs on time only while this session is live and otherwise becomes overdue until the session is resumed.', 'Cloudflare wakes this session when due; delivery waits for the shared execution slot without interrupting running work. No external notification is sent.'),
    execute: async (args, exec) => {
      const count = storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM dsh_schedule_active').toArray()[0]!.count
      if (count >= MAX_ACTIVE_SCHEDULES) return { code: 'invalid_rule', message: 'This owner already has 128 active reminders; delete one before creating another.' }
      if (new TextEncoder().encode(JSON.stringify((args as { prompt: string }).prompt)).byteLength > MAX_PROMPT_BYTES) return { code: 'invalid_prompt', message: 'Reminder prompt exceeds the 4 KiB JSON budget.' }
      return definition.execute(args, exec)
    },
  }))
  return () => { for (const stop of disposers) stop() }
}

/** Reserve before the asynchronous dispatch flush so concurrent user inputs cannot steal capacity. */
export function reserveScheduleAdmission(storage: DurableObjectStorage, sessionId: string, changes: ScheduleChange[]): boolean {
  const reminders: { record: EveryScheduleRecord; occurrenceAt: string }[] = []
  let text = ''
  for (const change of changes) {
    if (change.operation !== 'dispatch') continue
    const row = storage.sql.exec<ScheduleRow>('SELECT * FROM dsh_schedule_active WHERE session_id = ? AND schedule_id = ?', sessionId, change.id).toArray()[0]!
    const record = recordOf(row)
    if (record.kind === 'every' && 'acceptedAt' in change) reminders.push({ record, occurrenceAt: resolveEveryOccurrence(record, Date.parse(change.acceptedAt)).occurrenceAt })
    else if (record.kind !== 'every') text = renderReminderFraming(record)
  }
  if (reminders.length > 0) text = renderEveryReminderBatchFraming(reminders)
  // Includes nested JSON escaping plus a conservative message/id envelope budget.
  const bytes = new TextEncoder().encode(JSON.stringify(text)).byteLength + sessionId.length * 6 + 1024
  const total = storage.sql.exec<{ pending: number; bytes: number }>('SELECT pending,bytes FROM dsh_runtime_slot WHERE id = 1').toArray()[0]!
  if (total.pending >= MAIN_QUEUE_LIMIT || total.bytes + bytes > MAIN_QUEUE_BYTES) return false
  storage.sql.exec('INSERT INTO dsh_runtime_schedule_reservation VALUES (1,?)', bytes)
  return true
}

interface ScheduleRow extends Record<string, SqlStorageValue> {
  session_id: string
  schedule_id: string
  record: string
  due: number
  created_seq: number
}

export function initializeSchedules(storage: DurableObjectStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_schedule_active (
    session_id TEXT NOT NULL, schedule_id TEXT NOT NULL, record TEXT NOT NULL,
    due INTEGER NOT NULL, created_seq INTEGER NOT NULL, PRIMARY KEY(session_id,schedule_id))`)
  storage.sql.exec('CREATE INDEX IF NOT EXISTS dsh_schedule_due ON dsh_schedule_active(due,session_id,created_seq)')
  storage.sql.exec('CREATE TABLE IF NOT EXISTS dsh_schedule_retry (session_id TEXT PRIMARY KEY, retry_at INTEGER NOT NULL)')
}

function recordOf(row: ScheduleRow): ScheduleRecord {
  const change = decodeScheduleChange({ version: 1, operation: 'create', schedule: JSON.parse(row.record) as unknown })
  if (change.operation !== 'create') throw new Error('Invalid schedule record')
  return change.schedule
}

/** No history replay on wake or request paths. Paused sessions require explicit user recovery. */
export function nextSchedule(storage: DurableObjectStorage): { sessionId: string; due: number } | undefined {
  const row = storage.sql.exec<{ session_id: string; due: number }>(`SELECT s.session_id, max(s.due,coalesce(b.retry_at,0)) AS due
    FROM dsh_schedule_active s LEFT JOIN dsh_runtime_ready r ON r.session_id = s.session_id
    LEFT JOIN dsh_schedule_retry b ON b.session_id = s.session_id
    WHERE coalesce(r.paused,0) != 1 ORDER BY max(s.due,coalesce(b.retry_at,0)),s.session_id,s.created_seq LIMIT 1`).toArray()[0]
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
    SELECT ?,? WHERE EXISTS (SELECT 1 FROM dsh_schedule_active WHERE session_id = ?)
    ON CONFLICT(session_id) DO UPDATE SET retry_at = excluded.retry_at`, sessionId, retryAt, sessionId)
}

/** Keep retry storage bounded by sessions with active reminders, including deletion and repair. */
function pruneScheduleRetry(storage: DurableObjectStorage, sessionId: string): void {
  storage.sql.exec(`DELETE FROM dsh_schedule_retry WHERE session_id = ?
    AND NOT EXISTS (SELECT 1 FROM dsh_schedule_active WHERE session_id = ?)`, sessionId, sessionId)
}

/** Match upstream: one-shot first; otherwise batch the latest occurrence of each due Every. */
export function dueScheduleChanges(storage: DurableObjectStorage, sessionId: string, now: number): ScheduleChange[] {
  const rows = storage.sql.exec<ScheduleRow>(`SELECT * FROM dsh_schedule_active
    WHERE session_id = ? AND due <= ? ORDER BY due,created_seq`, sessionId, now).toArray()
  const records = rows.map(recordOf)
  const one = records.find(record => record.kind !== 'every')
  if (one !== undefined) return [{ version: 1, operation: 'dispatch', id: one.id }]
  return records.map(record => ({ version: 1, operation: 'dispatch', id: record.id, acceptedAt: new Date(now).toISOString() }))
}

/** Runs inside canonical append's transaction. A dispatch and its queued input commit together. */
export function persistScheduleChanges(storage: DurableObjectStorage, sessionId: string, events: readonly SessionEvent[], inheritedEventCount: number): void {
  const every: { record: EveryScheduleRecord; occurrenceAt: string }[] = []
  let batchSeq: number | undefined
  const enqueue = (text: string, seq: number) => {
    const id = `schedule:${sessionId}:${seq}`
    const message = freezeMessage({ ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'schedule' } }), id: MessageId(id) })
    insertMainInput(storage, sessionId, id, id, message, 'queued', true)
  }
  for (const event of events) {
    if (event.seq < inheritedEventCount || event.type !== 'schedule/change') continue
    const change = decodeScheduleChange(event.data)
    if (change.operation === 'create') {
      const record = change.schedule
      storage.sql.exec('INSERT INTO dsh_schedule_active VALUES (?,?,?,?,?)', sessionId, record.id, JSON.stringify(record), Date.parse(record.scheduledAt), event.seq)
      continue
    }
    const row = storage.sql.exec<ScheduleRow>('SELECT * FROM dsh_schedule_active WHERE session_id = ? AND schedule_id = ?', sessionId, change.id).toArray()[0]
    if (row === undefined) throw new Error('Schedule transition targets an inactive record')
    const record = recordOf(row)
    storage.sql.exec('DELETE FROM dsh_schedule_active WHERE session_id = ? AND schedule_id = ?', sessionId, change.id)
    if (change.operation !== 'dispatch') continue
    if (record.kind !== 'every') {
      enqueue(renderReminderFraming(record), event.seq)
    } else {
      if (!('acceptedAt' in change)) throw new Error('Every dispatch requires acceptedAt')
      const occurrence = resolveEveryOccurrence(record, Date.parse(change.acceptedAt))
      every.push({ record, occurrenceAt: occurrence.occurrenceAt })
      batchSeq ??= event.seq
      if (occurrence.nextScheduledAt !== undefined) {
        const next = { ...record, scheduledAt: occurrence.nextScheduledAt }
        storage.sql.exec('INSERT INTO dsh_schedule_active VALUES (?,?,?,?,?)', sessionId, record.id, JSON.stringify(next), Date.parse(next.scheduledAt), row.created_seq)
      }
    }
  }
  if (batchSeq !== undefined) enqueue(renderEveryReminderBatchFraming(every), batchSeq)
  pruneScheduleRetry(storage, sessionId)
}

/** Every member of a periodic dispatch batch shares one input; never infer safety from its seq alone. */
export function assertScheduleTailRepairable(rows: readonly { type: string; data: string }[]): void {
  for (const row of rows) {
    if (row.type !== 'schedule/change') continue
    let change: ScheduleChange
    try { change = decodeScheduleChange(JSON.parse(row.data) as unknown) }
    catch { throw new Error('Cannot automatically repair a malformed reminder event; delivery state is unknown.') }
    if (change.operation === 'dispatch') throw new Error('Cannot automatically repair a torn dispatched reminder; delivery may already have occurred.')
  }
}

/** Rare repair write: rebuild from the retained canonical prefix, never replay dispatch side effects. */
export function rebuildSchedules(storage: DurableObjectStorage, sessionId: string, events: readonly SessionEvent[], inheritedEventCount: SessionLogOffset): void {
  const folded = foldScheduleEvents(events, inheritedEventCount)
  const created = new Map<string, number>()
  for (const event of events) {
    if (event.seq < inheritedEventCount || event.type !== 'schedule/change') continue
    const change = decodeScheduleChange(event.data)
    if (change.operation === 'create') created.set(change.schedule.id, event.seq)
  }
  storage.sql.exec('DELETE FROM dsh_schedule_active WHERE session_id = ?', sessionId)
  const remaining = storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM dsh_schedule_active').toArray()[0]!.count
  if (remaining + folded.active.length > MAX_ACTIVE_SCHEDULES) throw new Error('Schedule repair would exceed the active reminder budget.')
  for (const record of folded.active) storage.sql.exec('INSERT INTO dsh_schedule_active VALUES (?,?,?,?,?)', sessionId, record.id, JSON.stringify(record), Date.parse(record.scheduledAt), created.get(record.id)!)
  pruneScheduleRetry(storage, sessionId)
}

/** Only advance the alarm here; the owner merges/removes all wake sources after driving. */
export async function armScheduleWake(storage: DurableObjectStorage): Promise<void> {
  const next = nextSchedule(storage)
  const pending = storage.sql.exec<{ pending: number }>('SELECT pending FROM dsh_runtime_slot WHERE id = 1').toArray()[0]!.pending
  const target = Math.min(next?.due ?? Infinity, pending > 0 ? Date.now() + MAIN_WAKE_MS : Infinity)
  if (!Number.isFinite(target)) return
  const alarm = await storage.getAlarm()
  if (alarm === null || target < alarm) await storage.setAlarm(Math.max(Date.now() + 1, target))
}
