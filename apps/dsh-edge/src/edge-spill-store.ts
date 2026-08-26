import type { Context } from '@deepseek-ai/cordis'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'

const SPILL_DIRECTORY = '/workspace/.spill'

export interface VfsWriter {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>
  writeFile(path: string, content: string): Promise<void>
}

export class EdgeVfsSpillStore extends SpillStore {
  private fs: VfsWriter | undefined
  private bindings = 0

  constructor(ctx: Context) { super(ctx) }

  bind(fs: VfsWriter): void { this.fs = fs; this.bindings++ }
  unbind(): void { if (--this.bindings <= 0) { this.fs = undefined; this.bindings = 0 } }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.fs === undefined) throw new Error('spill: no workspace filesystem bound')
    const safe = input.suggestedName.replace(/[^a-zA-Z0-9._-]/gu, '_')
    const name = `${safe}_${input.source.callId}.txt`
    const path = `${SPILL_DIRECTORY}/${name}`
    await this.fs.mkdir(SPILL_DIRECTORY, { recursive: true })
    await this.fs.writeFile(path, input.content)
    return {
      locator: SpillLocator(path),
      bytes: new TextEncoder().encode(input.content).byteLength,
      retrievalHint: `Use head/tail with byte limits to read in chunks: head -c 30000 ${path}, tail -c 30000 ${path}, or grep to search within it.`,
    }
  }
}
