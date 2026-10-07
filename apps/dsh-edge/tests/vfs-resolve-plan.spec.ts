import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

// The Worker bundles @cloudflare/computer from the standalone lock with
// standalone/patches/@cloudflare__computer@0.3.1.patch applied. This spec reads the
// unpatched published file (the app's own dev install), applies that patch's hunk,
// and asks SQLite how each version of the path-resolution query probes vfs_dirents.
const published = readFileSync(new URL('../node_modules/@cloudflare/computer/dist/index.js', import.meta.url), 'utf8')
const patch = readFileSync(new URL('../standalone/patches/@cloudflare__computer@0.3.1.patch', import.meta.url), 'utf8').replace(/\r\n/gu, '\n')

function applyHunk(source: string): string {
  const hunk = patch.slice(patch.indexOf('\n@@')).split('\n').slice(2)
  const before: string[] = []
  const after: string[] = []
  for (const line of hunk) {
    if (line.startsWith(' ')) { before.push(line.slice(1)); after.push(line.slice(1)) }
    else if (line.startsWith('-')) before.push(line.slice(1))
    else if (line.startsWith('+')) after.push(line.slice(1))
  }
  const old = before.join('\n')
  expect(source.includes(old), 'the patch hunk applies to the published file').toBe(true)
  return source.replace(old, after.join('\n'))
}

function resolveQuery(source: string): string {
  const match = /function resolveViaCte\(db, parts\) \{\s*const rows = db\.all\(`([\s\S]*?)`, JSON\.stringify\(parts\), 1\)/u.exec(source)
  expect(match, 'resolveViaCte keeps its single recursive query').not.toBeNull()
  return match![1]!
}

function direntProbe(query: string): string {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE vfs_nodes (inode INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, mode INTEGER NOT NULL DEFAULT 493,
      mtime INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, mount_root TEXT, stub_size INTEGER, manifest_hash BLOB,
      link_target TEXT, size INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE vfs_dirents (parent_inode INTEGER NOT NULL, name TEXT NOT NULL, child_inode INTEGER NOT NULL,
      PRIMARY KEY (parent_inode, name)) WITHOUT ROWID;
    CREATE INDEX vfs_dirents_by_child ON vfs_dirents(child_inode);`)
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(JSON.stringify(['workspace', 'a.txt']), 1) as Array<{ detail: string }>
    return plan.map(row => row.detail).find(detail => detail.startsWith('SEARCH d ')) ?? ''
  } finally {
    db.close()
  }
}

describe('workspace VFS path resolution', () => {
  it('probes directory entries by parent and name once the retained patch applies', () => {
    expect(direntProbe(resolveQuery(applyHunk(published)))).toBe('SEARCH d USING PRIMARY KEY (parent_inode=? AND name=?)')
  })

  it('still needs the patch: the published query probes by parent only (remove the patch when this fails)', () => {
    expect(direntProbe(resolveQuery(published))).toBe('SEARCH d USING PRIMARY KEY (parent_inode=?)')
  })
})
