import type { Context } from '@deepseek-ai/cordis'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'

const SPILL_DIRECTORY = '/workspace/.spill'

/** As upstream dsh-spill-local's default `cleanupPeriodDays`: a spill older than 30 days goes. */
export const SPILL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * One sweep lists at most `entries` spills and deletes at most `deletes`, so its
 * Durable Object rows stay bounded; a larger backlog drains over later sweeps.
 */
export const SPILL_SWEEP_LIMITS = { entries: 1_000, deletes: 200 } as const

export interface SpillFilesystem {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>
  writeFile(path: string, content: string): Promise<void>
  readdir(path: string, options?: { limit?: number }): Promise<Array<{ name: string; mtime: number; isFile: boolean }>>
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
    const name = `${crypto.randomUUID().slice(0, 8)}-${safe}_${suffix}.txt`
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
   * @returns how many spills were deleted.
   */
  async sweep(now: number): Promise<number> {
    const fs = this.fs
    if (fs === undefined) return 0
    let entries: Awaited<ReturnType<SpillFilesystem['readdir']>>
    try {
      entries = await fs.readdir(SPILL_DIRECTORY, { limit: SPILL_SWEEP_LIMITS.entries })
    } catch {
      return 0
    }
    const cutoff = now - SPILL_RETENTION_MS
    let deleted = 0
    for (const entry of entries) {
      if (deleted >= SPILL_SWEEP_LIMITS.deletes) break
      if (!entry.isFile || entry.mtime >= cutoff) continue
      try {
        await fs.rm(`${SPILL_DIRECTORY}/${entry.name}`)
        deleted++
      } catch (error) {
        console.warn(`dsh-edge: could not delete spill ${entry.name}`, error)
      }
    }
    return deleted
  }
}
