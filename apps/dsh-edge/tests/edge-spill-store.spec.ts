import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { EdgeVfsSpillStore, SPILL_RETENTION_MS, SPILL_SWEEP_LIMITS, nextSpillSweep, spillDeleteRows, type SpillFilesystem } from '../src/edge-spill-store.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 21)

function memoryFs(entries: Array<{ name: string; mtime: number; isFile?: boolean; size?: number }> = []) {
  const files = new Map(entries.map(entry => [`/workspace/.spill/${entry.name}`, { mtime: entry.mtime, isFile: entry.isFile ?? true, size: entry.size ?? 1, content: '' }]))
  const fs: SpillFilesystem & { files: typeof files } = {
    files,
    mkdir: async () => {},
    writeFile: async (path, content) => { files.set(path, { mtime: NOW, isFile: true, size: content.length, content }) },
    // Name order with offset paging, as the workspace VFS lists a directory.
    readdir: async (path, options) => [...files.entries()]
      .filter(([file]) => file.startsWith(`${path}/`))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? Infinity))
      .map(([file, entry]) => ({ name: file.slice(path.length + 1), mtime: entry.mtime, size: entry.size, isFile: entry.isFile })),
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
    expect(await store(fs).sweep(NOW)).toEqual({ deleted: 1, cursor: 0, complete: true })
    expect([...fs.files.keys()].map(path => path.split('/').pop() ?? '').sort((a, b) => a.localeCompare(b)))
      .toEqual(['edge.txt', 'fresh.txt', 'old-dir'])
  })

  it('bounds one sweep, so a backlog drains over later sweeps', async () => {
    const backlog = Array.from({ length: SPILL_SWEEP_LIMITS.deletes + 5 }, (_, index) => ({ name: `old-${String(index)}.txt`, mtime: 0 }))
    const fs = memoryFs(backlog)
    const spills = store(fs)
    const perSweep = Math.min(SPILL_SWEEP_LIMITS.deletes, Math.floor(SPILL_SWEEP_LIMITS.rows / spillDeleteRows(1)))
    const first = await spills.sweep(NOW)
    expect(first).toEqual({ deleted: perSweep, cursor: 0, complete: false })
    expect(await spills.sweep(NOW, first.cursor)).toEqual({ deleted: backlog.length - perSweep, cursor: 0, complete: true })
    expect(fs.files.size).toBe(0)
  })

  // Each sweep reads one bounded page; the cursor carries later sweeps past a
  // first page of fresh spills to expired ones further on, then wraps.
  it('resumes after a full page of fresh spills', async () => {
    const fresh = Array.from({ length: SPILL_SWEEP_LIMITS.entries }, (_, index) => ({ name: `a-${String(index).padStart(5, '0')}.txt`, mtime: NOW }))
    const fs = memoryFs([...fresh, { name: 'z-old.txt', mtime: 0 }])
    const spills = store(fs)
    const first = await spills.sweep(NOW)
    expect(first).toEqual({ deleted: 0, cursor: SPILL_SWEEP_LIMITS.entries, complete: false })
    expect(await spills.sweep(NOW, first.cursor)).toEqual({ deleted: 1, cursor: 0, complete: true })
    expect(fs.files.has('/workspace/.spill/z-old.txt')).toBe(false)
  })

  // Deleting a chunked VFS file writes a row per chunk, so a few large spills
  // exhaust the budget before the file cap; the rest wait for the next sweep.
  it('stops at the row budget, so large spills drain over several sweeps', async () => {
    const large = 40 * 1024 * 1024
    const fs = memoryFs(Array.from({ length: 30 }, (_, index) => ({ name: `big-${String(index).padStart(2, '0')}.txt`, mtime: 0, size: large })))
    const spills = store(fs)
    const perSweep = Math.floor(SPILL_SWEEP_LIMITS.rows / spillDeleteRows(large))
    const first = await spills.sweep(NOW)
    expect(first).toEqual({ deleted: perSweep, cursor: 0, complete: false })
    expect(fs.files.size).toBe(30 - perSweep)
    expect(spillDeleteRows(10)).toBe(9)
    expect(spillDeleteRows(1024 * 1024)).toBe(10)
  })

  it('does nothing without a bound workspace or a spill directory', async () => {
    expect(await store().sweep(NOW, 7)).toEqual({ deleted: 0, cursor: 7, complete: true })
    const missing = { ...memoryFs(), readdir: () => Promise.reject(new Error('ENOENT')) }
    expect(await store(missing).sweep(NOW, 7)).toEqual({ deleted: 0, cursor: 0, complete: true })
  })

  // A workspace that adds more spills a day than one sweep reads still
  // completes passes: an unfinished pass continues hourly, not daily, so
  // spills that were fresh when the cursor last passed them are revisited.
  // 30 s: about 1,000 simulated sweeps; Windows runners are several times slower.
  it('catches up hourly until a pass completes while the directory keeps growing', { timeout: 30_000 }, async () => {
    const HOUR = 60 * 60 * 1000
    const perDay = 2 * SPILL_SWEEP_LIMITS.entries
    // Names sort by creation, so the listing stays ordered by appending; a
    // sorted array keeps 40 simulated days fast.
    const listing: Array<{ name: string; mtime: number }> = []
    const indexOf = (name: string) => {
      let low = 0
      let high = listing.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (listing[middle]!.name < name) low = middle + 1
        else high = middle
      }
      return low
    }
    const fs: SpillFilesystem = {
      mkdir: async () => {},
      writeFile: async () => {},
      readdir: async (_path, options) => listing
        .slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? Infinity))
        .map(entry => ({ ...entry, size: 1, isFile: true })),
      rm: async path => { listing.splice(indexOf(path.slice(path.lastIndexOf('/') + 1)), 1) },
    }
    const spills = store(fs)
    let created = 0
    const grow = (until: number) => {
      while (created * (DAY / perDay) < until - NOW) {
        listing.push({ name: `${String(created).padStart(8, '0')}.txt`, mtime: NOW + created * (DAY / perDay) })
        created++
      }
    }
    let at = NOW
    let last = { at: NOW, cursor: 0, complete: true }
    const passes: number[] = []
    while (at < NOW + 40 * DAY) {
      grow(at)
      const result = await spills.sweep(at, last.cursor)
      last = { at, ...result }
      if (result.complete) passes.push(at)
      at = nextSpillSweep(last)
    }
    // Once the retained directory stops growing (about 60,000 spills), hourly
    // runs bounded by the delete and row budgets finish a pass in under five
    // days; passes keep completing, and nothing outlives the retention by more
    // than one pass. A daily-only schedule never completes one here.
    const gaps = passes.slice(1).map((pass, index) => pass - passes[index]!)
    expect(passes.length).toBeGreaterThanOrEqual(10)
    expect(Math.max(...gaps.slice(-5))).toBeLessThan(5 * DAY)
    const oldest = Math.min(...listing.map(file => file.mtime))
    expect(at - oldest).toBeLessThan(SPILL_RETENTION_MS + 5 * DAY)
    expect(nextSpillSweep({ at: 0, complete: true })).toBe(DAY)
    expect(nextSpillSweep({ at: 0, complete: false })).toBe(HOUR)
  })
})
