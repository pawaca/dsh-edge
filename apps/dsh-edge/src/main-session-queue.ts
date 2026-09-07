/** Bounded durable admission ledger for the owner's single live session. */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const MAIN_QUEUE_LIMIT = 128
export const MAIN_QUEUE_BYTES = 2 * 1024 * 1024
export const MAIN_RUN_TIMEOUT_MS = 10 * 60_000
export const MAIN_WAKE_MS = 30_000
interface InputRow extends Record<string, SqlStorageValue> {
  seq: number
  session_id: string
  input_id: string
  digest: string
  message: string
  state: string
  bytes: number
}
export interface MainInput {
  created: boolean
  seq: number
  sessionId: string
  inputId: string
  message: UserMessage
}

/** Shared schema initializer also used by the canonical persistence adapter. */
export function initializeMainQueue(storage: DurableObjectStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_runtime_inputs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, input_id TEXT NOT NULL,
    digest TEXT NOT NULL, message TEXT NOT NULL, bytes INTEGER NOT NULL,
    state TEXT NOT NULL, UNIQUE(session_id, input_id))`)
  storage.sql.exec('CREATE INDEX IF NOT EXISTS dsh_runtime_inputs_pending ON dsh_runtime_inputs(session_id, state, seq)')
  storage.sql.exec('CREATE INDEX IF NOT EXISTS dsh_runtime_inputs_state ON dsh_runtime_inputs(state, seq)')
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_runtime_ready (
    session_id TEXT PRIMARY KEY, position INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0)`)
  storage.sql.exec('CREATE INDEX IF NOT EXISTS dsh_runtime_ready_order ON dsh_runtime_ready(paused, position)')
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_runtime_slot (
    id INTEGER PRIMARY KEY CHECK(id = 1), input_seq INTEGER, epoch TEXT,
    deadline INTEGER, serial INTEGER NOT NULL DEFAULT 0,
    pending INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0)`)
  storage.sql.exec('INSERT OR IGNORE INTO dsh_runtime_slot(id) VALUES (1)')
}

/** Called inside canonical append's transaction, never in an async observer. */
export function acknowledgeMainInputs(storage: DurableObjectStorage, sessionId: string, events: readonly SessionEvent[]): void {
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    for (const message of event.data.inserted) {
      const queued = storage.sql.exec<{ seq: number; bytes: number }>(
        "SELECT seq, bytes FROM dsh_runtime_inputs WHERE session_id = ? AND input_id = ? AND state IN ('queued', 'steering')", sessionId, message.id,
      ).toArray()[0]
      if (queued !== undefined) {
        storage.sql.exec("UPDATE dsh_runtime_inputs SET state = 'settled', message = '{}', bytes = 0 WHERE seq = ?", queued.seq)
        storage.sql.exec('UPDATE dsh_runtime_slot SET pending = pending - 1, bytes = bytes - ? WHERE id = 1', queued.bytes)
      }
      storage.sql.exec(`UPDATE dsh_runtime_inputs SET state = 'admitted'
        WHERE session_id = ? AND input_id = ? AND state = 'claimed'`, sessionId, message.id)
    }
  }
}

/** SQLite is authoritative; no waiting request Promise owns a queued input. */
export class MainSessionQueue {
  private readonly startupClaim: ReturnType<MainSessionQueue['current']>
  constructor(private readonly storage: DurableObjectStorage) {
    initializeMainQueue(storage)
    this.startupClaim = this.current()
    // An uncommitted steer belongs to a dead run, never to a future ordinary turn.
    storage.transactionSync(() => {
      for (const row of this.rows("SELECT * FROM dsh_runtime_inputs WHERE state = 'steering' LIMIT ?", MAIN_QUEUE_LIMIT)) this.settle(row, 'interrupted')
    })
  }
  private rows(query: string, ...bindings: SqlStorageValue[]): InputRow[] {
    return this.storage.sql.exec<InputRow>(query, ...bindings).toArray()
  }
  hasReceipt(sessionId: string, inputId: string, digest: string): boolean {
    const old = this.rows('SELECT * FROM dsh_runtime_inputs WHERE session_id = ? AND input_id = ?', sessionId, inputId)[0]
    if (old === undefined) return false
    if (old.digest !== digest) throw new Error('Input identity was reused with different content.')
    return true
  }
  enqueue(sessionId: string, inputId: string, digest: string, message: UserMessage, steering = false): MainInput {
    return this.storage.transactionSync(() => {
      const old = this.rows('SELECT * FROM dsh_runtime_inputs WHERE session_id = ? AND input_id = ?', sessionId, inputId)[0]
      if (old !== undefined) {
        if (old.digest !== digest) throw new Error('Input identity was reused with different content.')
        return this.decode(old)
      }
      const encoded = JSON.stringify(message)
      const bytes = new TextEncoder().encode(encoded).byteLength
      const total = this.storage.sql.exec<{ pending: number; bytes: number }>('SELECT pending, bytes FROM dsh_runtime_slot WHERE id = 1').toArray()[0]!
      if (total.pending >= MAIN_QUEUE_LIMIT || total.bytes + bytes > MAIN_QUEUE_BYTES) throw new Error('Main session queue is full; retry later.')
      this.storage.sql.exec(`INSERT INTO dsh_runtime_inputs(session_id,input_id,digest,message,bytes,state) VALUES (?,?,?,?,?,?)`, sessionId, inputId, digest, encoded, bytes, steering ? 'steering' : 'queued')
      this.storage.sql.exec('UPDATE dsh_runtime_slot SET pending = pending + 1, bytes = bytes + ? WHERE id = 1', bytes)
      if (!steering) {
        this.ready(sessionId)
        this.resume(sessionId)
      }
      return this.decode(this.rows('SELECT * FROM dsh_runtime_inputs WHERE session_id = ? AND input_id = ?', sessionId, inputId)[0]!, true)
    })
  }
  private ready(sessionId: string): void {
    this.storage.sql.exec('UPDATE dsh_runtime_slot SET serial = serial + 1 WHERE id = 1')
    this.storage.sql.exec(`INSERT OR IGNORE INTO dsh_runtime_ready(session_id,position)
      SELECT ?, serial FROM dsh_runtime_slot WHERE id = 1`, sessionId)
  }
  claim(): { input: MainInput; epoch: string; deadline: number } | undefined {
    return this.storage.transactionSync(() => {
      if (this.current() !== undefined) return undefined
      const next = this.storage.sql.exec<{ session_id: string }>('SELECT session_id FROM dsh_runtime_ready WHERE paused = 0 ORDER BY position LIMIT 1').toArray()[0]
      if (next === undefined) return undefined
      const row = this.rows("SELECT * FROM dsh_runtime_inputs WHERE session_id = ? AND state = 'queued' ORDER BY seq LIMIT 1", next.session_id)[0]
      if (row === undefined) { this.storage.sql.exec('DELETE FROM dsh_runtime_ready WHERE session_id = ?', next.session_id); return undefined }
      const epoch = crypto.randomUUID()
      const deadline = Date.now() + MAIN_RUN_TIMEOUT_MS
      this.storage.sql.exec('UPDATE dsh_runtime_slot SET input_seq = ?, epoch = ?, deadline = ? WHERE id = 1', row.seq, epoch, deadline)
      this.storage.sql.exec("UPDATE dsh_runtime_inputs SET state = 'claimed' WHERE seq = ?", row.seq)
      return { input: this.decode(row), epoch, deadline }
    })
  }
  current(): { seq: number; epoch: string; deadline: number } | undefined {
    const row = this.storage.sql.exec<{ input_seq: number | null; epoch: string; deadline: number }>('SELECT input_seq, epoch, deadline FROM dsh_runtime_slot WHERE id = 1').toArray()[0]!
    return row.input_seq === null ? undefined : { seq: row.input_seq, epoch: row.epoch, deadline: row.deadline }
  }
  get(seq: number): MainInput | undefined {
    const row = this.rows('SELECT * FROM dsh_runtime_inputs WHERE seq = ?', seq)[0]
    return row === undefined ? undefined : this.decode(row)
  }
  state(seq: number): string | undefined { return this.rows('SELECT * FROM dsh_runtime_inputs WHERE seq = ?', seq)[0]?.state }
  finish(seq: number, epoch: string, interrupted: boolean): void {
    this.storage.transactionSync(() => {
      const current = this.current()
      if (current?.seq !== seq || current.epoch !== epoch) return
      const row = this.rows('SELECT * FROM dsh_runtime_inputs WHERE seq = ?', seq)[0]!
      const explicitlyResumed = this.storage.sql.exec<{ paused: number }>('SELECT paused FROM dsh_runtime_ready WHERE session_id = ?', row.session_id).toArray()[0]?.paused === -1
      this.settle(row, interrupted ? 'interrupted' : 'settled')
      this.storage.sql.exec('UPDATE dsh_runtime_slot SET input_seq = NULL, epoch = NULL, deadline = NULL WHERE id = 1')
      this.storage.sql.exec('DELETE FROM dsh_runtime_ready WHERE session_id = ?', row.session_id)
      if (this.pending(row.session_id).length > 0) {
        this.ready(row.session_id)
        if (interrupted && !explicitlyResumed) this.storage.sql.exec('UPDATE dsh_runtime_ready SET paused = 1 WHERE session_id = ?', row.session_id)
      }
    })
  }
  /** Explicit new user submission resumes a paused session; old work is never replayed. */
  resume(sessionId: string): void {
    const current = this.current()
    const staleOwner = current !== undefined && current.epoch === this.startupClaim?.epoch
      && this.get(current.seq)?.sessionId === sessionId
    // -1 durably remembers explicit post-restart intent until stale cleanup
    // rotates this session. Admission and this marker share one transaction.
    this.storage.sql.exec('UPDATE dsh_runtime_ready SET paused = ? WHERE session_id = ?', staleOwner ? -1 : 0, sessionId)
  }
  pending(sessionId: string): MainInput[] {
    return this.rows("SELECT * FROM dsh_runtime_inputs WHERE session_id = ? AND state = 'queued' ORDER BY seq LIMIT ?", sessionId, MAIN_QUEUE_LIMIT).map(row => this.decode(row))
  }
  sessions(): string[] { return this.storage.sql.exec<{ session_id: string }>('SELECT session_id FROM dsh_runtime_ready ORDER BY position LIMIT ?', MAIN_QUEUE_LIMIT).toArray().map(row => row.session_id) }
  hasWork(): boolean { return this.current() !== undefined || this.storage.sql.exec('SELECT session_id FROM dsh_runtime_ready WHERE paused = 0 ORDER BY position LIMIT 1').toArray().length > 0 }
  remove(sessionId: string, inputId: string): boolean {
    return this.storage.transactionSync(() => {
      const row = this.rows("SELECT * FROM dsh_runtime_inputs WHERE session_id = ? AND input_id = ? AND state IN ('queued', 'steering')", sessionId, inputId)[0]
      if (row === undefined) return false
      this.settle(row, 'cancelled')
      if (this.pending(sessionId).length === 0) this.storage.sql.exec('DELETE FROM dsh_runtime_ready WHERE session_id = ?', sessionId)
      return true
    })
  }
  stageSteer(seq: number): void {
    this.storage.sql.exec("UPDATE dsh_runtime_inputs SET state = 'steering' WHERE seq = ? AND state = 'queued'", seq)
  }
  edit(sessionId: string, inputId: string, message: UserMessage): void {
    this.storage.transactionSync(() => {
      const row = this.rows("SELECT * FROM dsh_runtime_inputs WHERE session_id = ? AND input_id = ? AND state = 'queued'", sessionId, inputId)[0]
      if (row === undefined) return
      const encoded = JSON.stringify(message)
      const bytes = new TextEncoder().encode(encoded).byteLength
      const total = this.storage.sql.exec<{ bytes: number }>('SELECT bytes FROM dsh_runtime_slot WHERE id = 1').toArray()[0]!.bytes
      if (total + bytes - row.bytes > MAIN_QUEUE_BYTES) throw new Error('Main queue byte limit exceeded.')
      this.storage.sql.exec('UPDATE dsh_runtime_inputs SET message = ?, bytes = ? WHERE seq = ?', encoded, bytes, row.seq)
      this.storage.sql.exec('UPDATE dsh_runtime_slot SET bytes = bytes + ? WHERE id = 1', bytes - row.bytes)
    })
  }
  private settle(row: InputRow, state: string): void {
    this.storage.sql.exec('UPDATE dsh_runtime_inputs SET state = ?, message = ?, bytes = 0 WHERE seq = ?', state, '{}', row.seq)
    this.storage.sql.exec('UPDATE dsh_runtime_slot SET pending = pending - 1, bytes = bytes - ? WHERE id = 1', row.bytes)
  }
  private decode(row: InputRow, created = false): MainInput { return { created, seq: row.seq, sessionId: row.session_id, inputId: row.input_id, message: JSON.parse(row.message) as UserMessage } }
}
