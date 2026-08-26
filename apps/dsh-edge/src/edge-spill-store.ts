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

  constructor(ctx: Context) { super(ctx) }

  bind(fs: VfsWriter): void { this.fs = fs }
  unbind(): void { this.fs = undefined }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.fs === undefined) throw new Error('spill: no workspace filesystem bound')
    const safe = input.suggestedName.replace(/[^a-zA-Z0-9._-]/gu, '_')
    const suffix = input.source.callId.slice(0, 8)
    const name = `${safe}_${suffix}.txt`
    const path = `${SPILL_DIRECTORY}/${name}`
    await this.fs.mkdir(SPILL_DIRECTORY, { recursive: true })
    await this.fs.writeFile(path, input.content)
    return {
      locator: SpillLocator(path),
      bytes: new TextEncoder().encode(input.content).byteLength,
      retrievalHint: `cat ${path}`,
    }
  }
}
