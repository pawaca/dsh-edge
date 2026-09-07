/// <reference types="node" />
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { createUserMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { acknowledgeMainInputs, MainQueueFullError, MAIN_QUEUE_BYTES, MAIN_QUEUE_LIMIT, MainSessionQueue, SteeringAdmissions } from '../src/main-session-queue.ts'
/** Minimal Node-backed implementation of the DO synchronous SQL surface. */
export class TestDurableObjectStorage {
  private readonly db = new DatabaseSync(':memory:')
  private eventInsertFailures = 0
  readonly queries: string[] = []

  sql = {
    exec: <T extends TestRow = TestRow>(
      query: string,
      ...bindings: SQLInputValue[]
    ): TestCursor<T> => {
      this.queries.push(query)
      if (/INSERT INTO dsh_session_events/u.test(query) && this.eventInsertFailures > 0) {
        this.eventInsertFailures -= 1
        throw new Error('injected event insert failure')
      }
      const statement = this.db.prepare(query)
      if (/^SELECT\b/i.test(query.trimStart())) {
        const rows = statement.all(...bindings) as T[]
        return cursor(rows, Object.keys(rows[0] ?? {}), 0)
      }
      const result = statement.run(...bindings)
      return cursor([], [], Number(result.changes))
    },
  }

  transactionSync<T>(callback: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  failNextEventInsert(): void {
    this.eventInsertFailures += 1
  }

  loadFixture(source: string): void {
    this.db.exec(source)
  }

  close() {
    this.db.close()
  }
}

type TestRow = Record<string, SQLOutputValue>

interface TestCursor<T extends TestRow> extends Iterable<T> {
  readonly columnNames: string[]
  readonly rowsRead: number
  readonly rowsWritten: number
  toArray(): T[]
}

function cursor<T extends TestRow>(
  rows: T[],
  columnNames: string[],
  rowsWritten: number,
): TestCursor<T> {
  return {
    columnNames,
    rowsRead: rows.length,
    rowsWritten,
    toArray: () => [...rows],
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  }
}


const message = (id: string) => freezeMessage({ ...createUserMessage({ content: [{ type: 'text', text: id }], source: { kind: 'user' } }), id: MessageId(id) })
describe('main session queue', () => {
  it('settles every steering entry path across durable success, blocked delivery, rejection and restart', async () => {
    for (const promoted of [false, true]) {
      for (const outcome of ['durable', 'blocked', 'rejected', 'crash'] as const) {
        const storage = new TestDurableObjectStorage()
        const queue = new MainSessionQueue(storage as never)
        const input = queue.enqueue('a', 'input', 'digest', message('input'), !promoted)
        if (promoted) queue.stageSteer(input.seq)
        const gate = Promise.withResolvers<{ durable: boolean }>()
        if (outcome !== 'crash') {
          const completing = queue.admitSteer('a', 'input', () => gate.promise)
          expect(queue.pending('a')).toEqual([])
          expect(storage.sql.exec('SELECT pending FROM dsh_runtime_slot').toArray()[0]?.pending).toBe(1)
          if (outcome === 'rejected') {
            const rejection = expect(completing).rejects.toThrow('inbox rejected')
            gate.reject(new Error('inbox rejected'))
            await rejection
          } else {
            if (outcome === 'durable') acknowledgeMainInputs(storage as never, 'a', [{ type: 'agent/inbox/spliced', data: { inserted: [input.message] } } as never])
            gate.resolve({ durable: outcome === 'durable' })
            await completing
          }
        }
        const restarted = new MainSessionQueue(storage as never)
        expect(storage.sql.exec('SELECT pending, bytes FROM dsh_runtime_slot').toArray()[0]).toMatchObject({ pending: 0, bytes: 0 })
        expect(restarted.pending('a')).toEqual([])
        expect(restarted.claim()).toBeUndefined()
        if (!promoted && (outcome === 'rejected' || outcome === 'crash')) {
          expect(() => restarted.hasReceipt('a', 'input', 'digest')).toThrow('rejected')
        } else {
          expect(restarted.hasReceipt('a', 'input', 'digest')).toBe(true)
          expect(restarted.enqueue('a', 'input', 'digest', message('input')).created).toBe(false)
        }
        storage.close()
      }
    }
  })

  it('rejects count and byte saturation atomically and accepts retries after capacity is freed', () => {
    const storage = new TestDurableObjectStorage()
    const queue = new MainSessionQueue(storage as never)
    for (let i = 0; i < MAIN_QUEUE_LIMIT; i++) queue.enqueue('a', `${i}`, `${i}`, message(`${i}`))
    expect(() => queue.enqueue('a', 'overflow', 'd', message('overflow'))).toThrow(MainQueueFullError)
    expect(queue.hasReceipt('a', 'overflow', 'd')).toBe(false)
    expect(queue.pending('a')).toHaveLength(MAIN_QUEUE_LIMIT)
    queue.remove('a', '0')
    expect(queue.enqueue('a', 'overflow', 'd', message('overflow')).created).toBe(true)
    const oversized = message('x'.repeat(MAIN_QUEUE_BYTES))
    expect(() => queue.edit('a', 'overflow', oversized)).toThrow(MainQueueFullError)
    expect(queue.pending('a').find(input => input.inputId === 'overflow')?.message.id).toBe('overflow')
    for (const input of queue.pending('a')) queue.remove('a', input.inputId)
    expect(() => queue.enqueue('a', 'bytes', 'b', oversized)).toThrow(MainQueueFullError)
    expect(queue.hasReceipt('a', 'bytes', 'b')).toBe(false)
    expect(queue.enqueue('a', 'bytes', 'b', message('small')).created).toBe(true)
    storage.close()
  })

  it('reports bounded steering admission overload and releases capacity after completion', async () => {
    const admissions = new SteeringAdmissions()
    const gate = Promise.withResolvers<void>()
    const pending = Array.from({ length: MAIN_QUEUE_LIMIT }, (_, i) => admissions.run(`${i}`, 'd', () => gate.promise))
    await expect(admissions.run('overflow', 'd', () => Promise.resolve())).rejects.toThrow(MainQueueFullError)
    expect(admissions.run('0', 'd', () => Promise.resolve())).toBe(pending[0])
    gate.resolve()
    await Promise.all(pending)
    await expect(admissions.run('overflow', 'd', () => Promise.resolve())).resolves.toBeUndefined()
  })

  it('shares steering success and failure across overlapping retries without replacing the owner', async () => {
    const admissions = new SteeringAdmissions()
    for (const fail of [false, true]) {
      const gate = Promise.withResolvers<void>()
      let calls = 0
      const first = admissions.run('same', 'digest', () => { calls++; return gate.promise })
      const duplicate = admissions.run('same', 'digest', () => { calls++; return Promise.resolve() })
      expect(duplicate).toBe(first)
      await expect(admissions.run('same', 'changed', () => Promise.resolve())).rejects.toThrow('different content')
      const results = Promise.allSettled([first, duplicate])
      if (fail) gate.reject(new Error('inbox admission failed'))
      else gate.resolve()
      expect((await results).map(result => result.status)).toEqual([fail ? 'rejected' : 'fulfilled', fail ? 'rejected' : 'fulfilled'])
      expect(calls).toBe(1)
    }
  })

  it('does not acknowledge pending or rejected steering receipts, including after restart', () => {
    const storage = new TestDurableObjectStorage()
    const queue = new MainSessionQueue(storage as never)
    queue.enqueue('a', 'failed', 'd1', message('failed'), true)
    expect(queue.hasReceipt('a', 'failed', 'd1')).toBe(false)
    queue.finishSteer('a', 'failed', false)
    const restarted = new MainSessionQueue(storage as never)
    expect(() => restarted.hasReceipt('a', 'failed', 'd1')).toThrow('rejected')
    expect(() => restarted.enqueue('a', 'failed', 'd1', message('failed'), true)).toThrow('rejected')
    restarted.enqueue('a', 'accepted', 'd2', message('accepted'), true)
    restarted.finishSteer('a', 'accepted', true)
    expect(restarted.hasReceipt('a', 'accepted', 'd2')).toBe(true)
    restarted.enqueue('a', 'removed', 'd3', message('removed'))
    restarted.remove('a', 'removed')
    expect(restarted.hasReceipt('a', 'removed', 'd3')).toBe(true)
    storage.close()
  })

  it('preserves explicit post-restart admission across stale cleanup and another restart', () => {
    const storage = new TestDurableObjectStorage()
    const queue = new MainSessionQueue(storage as never)
    queue.enqueue('a', 'running', 'd1', message('running'))
    const claim = queue.claim()!
    queue.enqueue('a', 'old-pending', 'd2', message('old-pending'))
    const restarted = new MainSessionQueue(storage as never)
    restarted.enqueue('a', 'resume-message', 'd3', message('resume-message'))
    const restartedAgain = new MainSessionQueue(storage as never)
    restartedAgain.finish(claim.input.seq, claim.epoch, true)
    expect(restartedAgain.state(claim.input.seq)).toBe('interrupted')
    const next = restartedAgain.claim()!
    expect(next.input.inputId).toBe('old-pending')
    restartedAgain.finish(next.input.seq, next.epoch, false)
    expect(restartedAgain.claim()!.input.inputId).toBe('resume-message')
    storage.close()
  })

  it('does not treat an ordinary pre-crash queued input or duplicate retry as resume', () => {
    const storage = new TestDurableObjectStorage()
    const queue = new MainSessionQueue(storage as never)
    queue.enqueue('a', 'running', 'd1', message('running'))
    const claim = queue.claim()!
    queue.enqueue('a', 'pending', 'd2', message('pending'))
    const restarted = new MainSessionQueue(storage as never)
    restarted.enqueue('a', 'pending', 'd2', message('pending'))
    restarted.finish(claim.input.seq, claim.epoch, true)
    expect(restarted.claim()).toBeUndefined()
    storage.close()
  })

  it('never schedules an uncommitted steer as an ordinary turn after the target ends', () => {
    const storage = new TestDurableObjectStorage()
    const queue = new MainSessionQueue(storage as never)
    const steer = queue.enqueue('a', 'steer', 'digest', message('steer'), true)
    expect(queue.claim()).toBeUndefined()
    expect(queue.state(steer.seq)).toBe('steering')
    const restarted = new MainSessionQueue(storage as never)
    expect(restarted.state(steer.seq)).toBe('rejected')
    expect(restarted.claim()).toBeUndefined()
    storage.close()
  })

  it('owns one slot and rotates sessions rather than draining one inbox', () => {
    const storage = new TestDurableObjectStorage()
    const queue = new MainSessionQueue(storage as never)
    queue.enqueue('a', '1', 'd1', message('1'))
    queue.enqueue('a', '2', 'd2', message('2'))
    queue.enqueue('b', '3', 'd3', message('3'))
    const first = queue.claim()!
    expect(first.input.inputId).toBe('1')
    expect(queue.claim()).toBeUndefined()
    queue.finish(first.input.seq, 'stale-epoch', false)
    expect(queue.claim()).toBeUndefined()
    queue.finish(first.input.seq, first.epoch, false)
    const second = queue.claim()!
    expect(second.input.sessionId).toBe('b')
    queue.finish(second.input.seq, second.epoch, false)
    expect(queue.claim()!.input.inputId).toBe('2')
    storage.close()
  })
  it('deduplicates durable receipts, bounds admission and pauses interrupted work', () => {
    const storage = new TestDurableObjectStorage()
    const queue = new MainSessionQueue(storage as never)
    const first = queue.enqueue('a', '1', 'digest', message('1'))
    const duplicate = queue.enqueue('a', '1', 'digest', message('1'))
    expect(duplicate.seq).toBe(first.seq)
    expect(first.created).toBe(true)
    expect(duplicate.created).toBe(false)
    expect(() => queue.enqueue('a', '1', 'changed', message('1'))).toThrow('different content')
    queue.enqueue('a', '2', 'd2', message('2'))
    const claim = queue.claim()!
    const restarted = new MainSessionQueue(storage as never)
    expect(restarted.current()?.epoch).toBe(claim.epoch)
    restarted.finish(first.seq, claim.epoch, true)
    expect(restarted.hasWork()).toBe(false)
    expect(restarted.claim()).toBeUndefined()
    restarted.resume('a')
    expect(restarted.claim()!.input.inputId).toBe('2')
    storage.close()
  })
})
