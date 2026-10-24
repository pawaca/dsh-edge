import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  VFS_RECLAIM_GRACE_MS,
  VFS_RECLAIM_LIMITS,
  VFS_RECLAIM_SCHEMA_VERSION,
  reclaimUnreferencedBlobs,
} from '../src/edge-vfs-reclaim.ts'

// The pass runs against Computer's own tables, so these tests build them from
// the installed package's statements rather than from a copy.
const computer = readFileSync(new URL('../node_modules/@cloudflare/computer/dist/index.js', import.meta.url), 'utf8')

function statement(table: string): string {
  const match = new RegExp(`\`(CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\)(?: WITHOUT ROWID)?)\``, 'u').exec(computer)
  expect(match, `Computer declares ${table}`).not.toBeNull()
  return match![1]!
}

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function storage(schemaVersion: number | null = VFS_RECLAIM_SCHEMA_VERSION, tables = true) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  if (tables) for (const table of ['vfs_meta', 'vfs_blobs', 'vfs_blob_bytes', 'vfs_chunks']) db.exec(statement(table))
  if (tables && schemaVersion !== null) db.prepare("INSERT INTO vfs_meta (k, v) VALUES ('schema_version', ?)").run(schemaVersion)
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const prepared = db.prepare(query)
      const rows = prepared.columns().length > 0 ? prepared.all(...bindings as never[]) : (prepared.run(...bindings as never[]), [])
      // Workers returns BLOB columns as ArrayBuffer.
      const converted = rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) =>
        [k, v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v])))
      return { toArray: () => converted }
    },
  }
  const transactionSync = vi.fn(<T>(run: () => T): T => {
    db.exec('BEGIN')
    try {
      const result = run()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
  const blob = (n: number, lastSeen: number, linked: boolean) => {
    const hash = new Uint8Array(32)
    hash[0] = n >> 8
    hash[1] = n & 0xff
    db.prepare('INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, ?)').run(hash, 10, lastSeen)
    db.prepare('INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?)').run(hash, new Uint8Array(10))
    if (linked) db.prepare('INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, 0, ?, 10)').run(n, hash)
  }
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  return { storage: { sql, transactionSync } as unknown as DurableObjectStorage, blob, count, db }
}

describe('reclaimUnreferencedBlobs', () => {
  it('deletes only blobs no chunk references and not seen within the grace', () => {
    const s = storage()
    s.blob(1, NOW - 2 * DAY, false) // deleted file's content
    s.blob(2, NOW - 2 * DAY, true) // still linked
    s.blob(3, NOW - VFS_RECLAIM_GRACE_MS + 1_000, false) // staged recently, maybe mid-write
    const result = reclaimUnreferencedBlobs(s.storage, NOW)
    expect(result).toEqual({ deleted: 1, bytes: 10, complete: true })
    expect(s.count('vfs_blobs')).toBe(2)
    expect(s.count('vfs_blob_bytes')).toBe(2)
    expect(s.count('vfs_chunks')).toBe(1)
  })

  it('reads one bounded page and continues after it', () => {
    const s = storage()
    const total = VFS_RECLAIM_LIMITS.scanned + 5
    for (let n = 0; n < total; n++) s.blob(n, NOW - 2 * DAY, true)
    s.blob(total, NOW - 2 * DAY, false)
    const first = reclaimUnreferencedBlobs(s.storage, NOW)
    expect(first.deleted).toBe(0)
    expect(first.complete).toBe(false)
    expect(first.cursor).toMatch(/^[0-9a-f]{64}$/u)
    const second = reclaimUnreferencedBlobs(s.storage, NOW, first.cursor)
    expect(second).toEqual({ deleted: 1, bytes: 10, complete: true })
    expect(s.count('vfs_blobs')).toBe(total)
  })

  it('stops at its delete budget and resumes without skipping', () => {
    const s = storage()
    const total = VFS_RECLAIM_LIMITS.deleted + 3
    for (let n = 0; n < total; n++) s.blob(n, NOW - 2 * DAY, false)
    const first = reclaimUnreferencedBlobs(s.storage, NOW)
    expect(first.deleted).toBe(VFS_RECLAIM_LIMITS.deleted)
    expect(first.complete).toBe(false)
    const second = reclaimUnreferencedBlobs(s.storage, NOW, first.cursor)
    expect(second).toEqual({ deleted: 3, bytes: 30, complete: true })
    expect(s.count('vfs_blobs')).toBe(0)
    expect(s.count('vfs_blob_bytes')).toBe(0)
  })

  it('leaves a store of another schema version alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = storage(VFS_RECLAIM_SCHEMA_VERSION + 1)
    s.blob(1, NOW - 2 * DAY, false)
    expect(reclaimUnreferencedBlobs(s.storage, NOW)).toEqual({ deleted: 0, bytes: 0, complete: true, skipped: 'schema' })
    expect(s.count('vfs_blobs')).toBe(1)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
    expect(reclaimUnreferencedBlobs(storage(null).storage, NOW)).toEqual({ deleted: 0, bytes: 0, complete: true, skipped: 'no-vfs' })
    expect(reclaimUnreferencedBlobs(storage(null, false).storage, NOW)).toEqual({ deleted: 0, bytes: 0, complete: true, skipped: 'no-vfs' })
  })
})

// What the pass assumes about Computer, checked against the installed package
// so an upgrade that changes it fails here instead of deleting live content.
describe('Computer VFS assumptions', () => {
  it('is the schema version the pass was written against', () => {
    expect(computer).toContain(`"schema_version", ${String(VFS_RECLAIM_SCHEMA_VERSION)});`)
  })

  it('still never deletes blobs itself', () => {
    expect(computer).not.toMatch(/DELETE FROM vfs_blob/u)
  })

  it('refreshes last_seen whenever it stages or links a blob', () => {
    const writes = computer.match(/INSERT INTO vfs_blobs[^"]*"/gu) ?? []
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) expect(write).toContain('last_seen = excluded.last_seen')
  })

  it('references blobs only from vfs_chunks', () => {
    // Tables whose columns are named hash: blobs, their bytes, chunks, and
    // manifests (written, never read back).
    const tables = [...computer.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([^`]*)\)/gu)]
      .filter(([, , body]) => /^\s*hash\s/mu.test(body!))
      .map(([, name]) => name)
    expect(new Set(tables)).toEqual(new Set(['vfs_blobs', 'vfs_blob_bytes', 'vfs_chunks', 'vfs_manifests']))
    expect(computer).not.toMatch(/FROM vfs_manifests/u)
  })
})
