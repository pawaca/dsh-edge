import type { Context } from '@deepseek-ai/cordis'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'

const SPILL_DIRECTORY = '/workspace/.spill'

/** As upstream dsh-spill-local's default `cleanupPeriodDays`: a spill older than 30 days goes. */
export const SPILL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * One sweep lists at most `entries` spills and deletes at most `deletes`, spending
 * at most `rows` estimated rows written; a larger backlog drains over later sweeps.
 */
export const SPILL_SWEEP_LIMITS = { entries: 1_000, deletes: 200, rows: 1_000 } as const

/**
 * Rows one delete writes in the workspace VFS: measured in workerd as 9 for a
 * file of one 512 KiB chunk and 10 for two, so about 8 plus one per chunk.
 */
export function spillDeleteRows(bytes: number): number {
  return 8 + Math.max(1, Math.ceil(bytes / (512 * 1024)))
}

export interface SpillFilesystem {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>
  writeFile(path: string, content: string): Promise<void>
  readdir(path: string, options?: { limit?: number; offset?: number }): Promise<Array<{ name: string; mtime: number; size: number; isFile: boolean }>>
  rm(path: string): Promise<void>
}

export class EdgeVfsSpillStore extends SpillStore {
  private fs: SpillFilesystem | undefined
  private bindings = 0

  constructor(ctx: Context) { super(ctx) }

  bind(fs: SpillFilesystem): void { this.fs = fs; this.bindings++ }
  unbind(): void { if (--this.bindings <= 0) { this.fs = undefined; this.bindings = 0 } }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.fs === undefined) throw new Error('spill: no workspace filesystem bound')
    const safe = input.suggestedName.replace(/[^a-zA-Z0-9._-]/gu, '_')
    const suffix = input.source.kind === 'tool' ? input.source.callId : input.source.sessionId
    // A random prefix keeps two saves of the same name apart, as upstream's does:
    // a later reference to the same session must not replace an earlier spill.
    const name = `${crypto.randomUUID()}-${safe}_${suffix}.txt`
    const path = `${SPILL_DIRECTORY}/${name}`
    await this.fs.mkdir(SPILL_DIRECTORY, { recursive: true })
    await this.fs.writeFile(path, input.content)
    return {
      locator: SpillLocator(path),
      bytes: new TextEncoder().encode(input.content).byteLength,
      retrievalHint: `Use head/tail with byte limits to read in chunks: head -c 30000 ${path}, tail -c 30000 ${path}, or grep to search within it.`,
    }
  }

  /**
   * Delete spills older than the retention, as upstream sweeps its spill root
   * on start. Best effort: a missing directory or a failed delete is skipped.
   * One sweep reads one bounded page from `cursor` (entries in name order), so
   * the caller keeps the returned cursor and later sweeps reach the rest of
   * the directory before wrapping to its start.
   * @returns how many spills were deleted and where the next sweep starts.
   */
  async sweep(now: number, cursor = 0): Promise<{ deleted: number; cursor: number }> {
    const fs = this.fs
    if (fs === undefined) return { deleted: 0, cursor }
    let entries: Awaited<ReturnType<SpillFilesystem['readdir']>>
    try {
      entries = await fs.readdir(SPILL_DIRECTORY, { limit: SPILL_SWEEP_LIMITS.entries, offset: cursor })
    } catch {
      return { deleted: 0, cursor: 0 }
    }
    const cutoff = now - SPILL_RETENTION_MS
    let deleted = 0
    let read = 0
    let rows = 0
    for (const entry of entries) {
      if (deleted >= SPILL_SWEEP_LIMITS.deletes) break
      const expired = entry.isFile && entry.mtime < cutoff
      // Billed rows grow with a file's chunks, so the budget, not the file count,
      // decides how much one sweep may delete.
      if (expired && rows + spillDeleteRows(entry.size) > SPILL_SWEEP_LIMITS.rows) break
      read++
      if (!expired) continue
      rows += spillDeleteRows(entry.size)
      try {
        await fs.rm(`${SPILL_DIRECTORY}/${entry.name}`)
        deleted++
      } catch (error) {
        console.warn(`dsh-edge: could not delete spill ${entry.name}`, error)
      }
    }
    // A short page reached the end of the directory: start over next time.
    // Otherwise resume after what this sweep read and kept; deleting shifted
    // the later entries down by the number deleted.
    const exhausted = entries.length < SPILL_SWEEP_LIMITS.entries && read === entries.length
    return { deleted, cursor: exhausted ? 0 : cursor + read - deleted }
  }
}
