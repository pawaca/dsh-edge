import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { EdgeVfsSpillStore, SPILL_RETENTION_MS, SPILL_SWEEP_LIMITS, type SpillFilesystem } from '../src/edge-spill-store.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 21)

function memoryFs(entries: Array<{ name: string; mtime: number; isFile?: boolean }> = []) {
  const files = new Map(entries.map(entry => [`/workspace/.spill/${entry.name}`, { mtime: entry.mtime, isFile: entry.isFile ?? true, content: '' }]))
  const fs: SpillFilesystem & { files: typeof files } = {
    files,
    mkdir: async () => {},
    writeFile: async (path, content) => { files.set(path, { mtime: NOW, isFile: true, content }) },
    // Name order with offset paging, as the workspace VFS lists a directory.
    readdir: async (path, options) => [...files.entries()]
      .filter(([file]) => file.startsWith(`${path}/`))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? Infinity))
      .map(([file, entry]) => ({ name: file.slice(path.length + 1), mtime: entry.mtime, isFile: entry.isFile })),
    rm: async path => { files.delete(path) },
  }
  return fs
}

function store(fs?: SpillFilesystem) {
  const spills = new EdgeVfsSpillStore(new Context())
  if (fs !== undefined) spills.bind(fs)
  return spills
}

const spill = (suggestedName: string, sessionId: string) => ({
  suggestedName,
  content: 'captured text',
  source: { kind: 'session-reference', sessionId },
}) as never

describe('EdgeVfsSpillStore', () => {
  // Session references name a spill after the referenced session, so a later
  // reference to the same session used to replace the earlier file.
  it('keeps two saves of the same name and source apart', async () => {
    const fs = memoryFs()
    const spills = store(fs)
    const first = await spills.saveText(spill('session-reference-1.txt', 'session-a'))
    const second = await spills.saveText(spill('session-reference-1.txt', 'session-a'))
    expect(first.locator).not.toBe(second.locator)
    expect(String(first.locator)).toMatch(/^\/workspace\/\.spill\/[0-9a-f-]{36}-session-reference-1\.txt_session-a\.txt$/u)
    expect(fs.files.size).toBe(2)
  })

  it('deletes spills older than the retention and keeps newer ones and directories', async () => {
    const fs = memoryFs([
      { name: 'old.txt', mtime: NOW - SPILL_RETENTION_MS - 1 },
      { name: 'edge.txt', mtime: NOW - SPILL_RETENTION_MS },
      { name: 'fresh.txt', mtime: NOW - DAY },
      { name: 'old-dir', mtime: NOW - 400 * DAY, isFile: false },
    ])
    expect(await store(fs).sweep(NOW)).toEqual({ deleted: 1, cursor: 0 })
    expect([...fs.files.keys()].map(path => path.split('/').pop() ?? '').sort((a, b) => a.localeCompare(b)))
      .toEqual(['edge.txt', 'fresh.txt', 'old-dir'])
  })

  it('bounds one sweep, so a backlog drains over later sweeps', async () => {
    const backlog = Array.from({ length: SPILL_SWEEP_LIMITS.deletes + 5 }, (_, index) => ({ name: `old-${String(index)}.txt`, mtime: 0 }))
    const fs = memoryFs(backlog)
    const spills = store(fs)
    const first = await spills.sweep(NOW)
    expect(first).toEqual({ deleted: SPILL_SWEEP_LIMITS.deletes, cursor: 0 })
    expect(await spills.sweep(NOW, first.cursor)).toEqual({ deleted: 5, cursor: 0 })
    expect(fs.files.size).toBe(0)
  })

  // Each sweep reads one bounded page; the cursor carries later sweeps past a
  // first page of fresh spills to expired ones further on, then wraps.
  it('resumes after a full page of fresh spills', async () => {
    const fresh = Array.from({ length: SPILL_SWEEP_LIMITS.entries }, (_, index) => ({ name: `a-${String(index).padStart(5, '0')}.txt`, mtime: NOW }))
    const fs = memoryFs([...fresh, { name: 'z-old.txt', mtime: 0 }])
    const spills = store(fs)
    const first = await spills.sweep(NOW)
    expect(first).toEqual({ deleted: 0, cursor: SPILL_SWEEP_LIMITS.entries })
    expect(await spills.sweep(NOW, first.cursor)).toEqual({ deleted: 1, cursor: 0 })
    expect(fs.files.has('/workspace/.spill/z-old.txt')).toBe(false)
  })

  it('does nothing without a bound workspace or a spill directory', async () => {
    expect(await store().sweep(NOW, 7)).toEqual({ deleted: 0, cursor: 7 })
    const missing = { ...memoryFs(), readdir: () => Promise.reject(new Error('ENOENT')) }
    expect(await store(missing).sweep(NOW, 7)).toEqual({ deleted: 0, cursor: 0 })
  })
})
