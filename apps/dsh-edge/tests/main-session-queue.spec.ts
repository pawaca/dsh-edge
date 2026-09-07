/// <reference types="node" />
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { createUserMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { MainSessionQueue } from '../src/main-session-queue.ts'
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
  it('never schedules an uncommitted steer as an ordinary turn after the target ends', () => {
    const storage = new TestDurableObjectStorage()
    const queue = new MainSessionQueue(storage as never)
    const steer = queue.enqueue('a', 'steer', 'digest', message('steer'), true)
    expect(queue.claim()).toBeUndefined()
    expect(queue.state(steer.seq)).toBe('steering')
    const restarted = new MainSessionQueue(storage as never)
    expect(restarted.state(steer.seq)).toBe('interrupted')
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
    expect(queue.enqueue('a', '1', 'digest', message('1')).seq).toBe(first.seq)
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
