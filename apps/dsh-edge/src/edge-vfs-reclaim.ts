/**
 * Reclaim workspace content no file references (#358).
 *
 * Computer's VFS stores file bytes as content-addressed blobs (`vfs_blobs`,
 * `vfs_blob_bytes`) that files reach through `vfs_chunks`. Deleting or
 * overwriting a file removes its chunk rows and never its blobs, so storage
 * only grows. This pass deletes blobs no chunk references, a bounded page at a
 * time, and depends on Computer's internal schema: it runs only on the schema
 * version it was checked against.
 */

/** The VFS schema version (`vfs_meta.schema_version`) this pass was written against. */
export const VFS_RECLAIM_SCHEMA_VERSION = 10

/**
 * A blob is staged before a file links it: a streamed write stages each chunk
 * as it arrives and links them at the end, and a container pull stages
 * fetched objects, or finds one already stored, before it applies its
 * entries. Every stage refreshes `last_seen`, so a blob seen within this
 * window is never reclaimed, and the caller skips the pass while a container
 * runs.
 */
export const VFS_RECLAIM_GRACE_MS = 24 * 60 * 60 * 1000

/** One pass reads at most `scanned` blobs and deletes at most `deleted`; a larger store drains over later passes. */
export const VFS_RECLAIM_LIMITS = { scanned: 1_000, deleted: 200 } as const

export interface VfsReclaimResult {
  deleted: number
  bytes: number
  /** Hex hash the next pass starts after; absent once a pass reached the end. */
  cursor?: string
  complete: boolean
  /** Why nothing ran, when the store is not one this pass knows. */
  skipped?: 'no-vfs' | 'schema'
}

interface BlobRow extends Record<string, SqlStorageValue> {
  hash: ArrayBuffer
  size: number
  last_seen: number
  used: number
}

/** Delete one bounded page of unreferenced blobs, starting after `cursor`. */
export function reclaimUnreferencedBlobs(storage: DurableObjectStorage, now: number, cursor?: string): VfsReclaimResult {
  const sql = storage.sql
  const hasVfs = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vfs_meta'").toArray().length > 0
  const version = hasVfs
    ? sql.exec<{ v: number }>("SELECT v FROM vfs_meta WHERE k = 'schema_version'").toArray()[0]?.v
    : undefined
  if (version === undefined) return { deleted: 0, bytes: 0, complete: true, skipped: 'no-vfs' }
  if (version !== VFS_RECLAIM_SCHEMA_VERSION) {
    console.warn(`dsh-edge: workspace storage schema ${String(version)} is not ${String(VFS_RECLAIM_SCHEMA_VERSION)}; not reclaiming deleted content.`)
    return { deleted: 0, bytes: 0, complete: true, skipped: 'schema' }
  }
  const after = cursor === undefined ? new Uint8Array(0) : hexToBytes(cursor)
  // Bounded probe (AGENTS.md): the page is a primary-key range under LIMIT,
  // and each EXISTS is one seek on the covering vfs_chunks_by_hash index that
  // stops at the first reference, so a page reads at most about twice
  // `scanned` rows (measured: 72 blobs, 72 more rows read). A join or IN list
  // would read every reference to a shared chunk instead.
  const rows = sql.exec<BlobRow>(
    `SELECT b.hash, b.size, b.last_seen,
            EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = b.hash) AS used
       FROM vfs_blobs b
      WHERE b.hash > ?
      ORDER BY b.hash
      LIMIT ?`,
    after,
    VFS_RECLAIM_LIMITS.scanned,
  ).toArray()
  const cutoff = now - VFS_RECLAIM_GRACE_MS
  let deleted = 0
  let bytes = 0
  let read = 0
  for (const row of rows) {
    const reclaimable = row.used === 0 && row.last_seen < cutoff
    if (reclaimable && deleted >= VFS_RECLAIM_LIMITS.deleted) break
    read++
    if (!reclaimable) continue
    storage.transactionSync(() => {
      sql.exec('DELETE FROM vfs_blob_bytes WHERE hash = ?', row.hash)
      sql.exec('DELETE FROM vfs_blobs WHERE hash = ?', row.hash)
    })
    deleted++
    bytes += row.size
  }
  // A short page read to its end finished the pass. Otherwise the next pass
  // starts after the last blob read: the page is keyed by hash, so deletes do
  // not shift it, and a pass stopped at its delete budget has read at least
  // the blob before the one it stopped at.
  const exhausted = rows.length < VFS_RECLAIM_LIMITS.scanned && read === rows.length
  return exhausted
    ? { deleted, bytes, complete: true }
    : { deleted, bytes, cursor: bytesToHex(rows[read - 1]!.hash), complete: false }
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
