import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { assertSessionLogExportable, MAX_SESSION_LOG_EXPORT_BYTES, type SessionLogExportSources } from '../src/edge-session-log-export.ts'
import { EdgeHttpError } from '../src/http.ts'

const MIB = 1024 * 1024
const root = SessionId('session-root')
const child = SessionId('session-child')
const grandchild = SessionId('session-grandchild')

function sources(bytes: Record<string, number>, tree: readonly SessionId[] = [root]): SessionLogExportSources & { flushed: string[] } {
  const flushed: string[] = []
  return {
    flushed,
    flush: vi.fn(async (id) => { flushed.push(String(id)) }),
    eventBytes: id => bytes[String(id)] ?? 0,
    sessionIds: async (id, includeDescendants) => includeDescendants ? tree : [id],
  }
}

describe('session log export guard', () => {
  it('admits logs within the budget, saving each live session before measuring it', async () => {
    const source = sources({ [root]: 1 * MIB }, [root, child])
    await expect(assertSessionLogExportable(source, root, true, new AbortController().signal)).resolves.toBeUndefined()
    expect(source.flushed).toEqual(['session-root', 'session-child'])
  })

  it('applies the budget to each log on its own, since subagents are exported one at a time', async () => {
    const each = MAX_SESSION_LOG_EXPORT_BYTES - 1
    const source = sources({ [root]: each, [child]: each, [grandchild]: each }, [root, child, grandchild])
    await expect(assertSessionLogExportable(source, root, true, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('refuses a session log over the budget with a 413 that says how large it is', async () => {
    const source = sources({ [root]: 12 * MIB })
    const refused = await assertSessionLogExportable(source, root, false, new AbortController().signal).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(EdgeHttpError)
    expect(refused).toMatchObject({ status: 413 })
    expect((refused as Error).message).toContain('this session holds 12.0 MiB')
    expect((refused as Error).message).toContain(`at most ${String(MAX_SESSION_LOG_EXPORT_BYTES / MIB)}.0 MiB`)
  })

  it('names an oversized subagent log and suggests exporting without subagents', async () => {
    const source = sources({ [root]: 1 * MIB, [child]: 9 * MIB }, [root, child])
    const refused = await assertSessionLogExportable(source, root, true, new AbortController().signal).catch((error: unknown) => error)
    expect(refused).toMatchObject({ status: 413 })
    expect((refused as Error).message).toContain('its subagent session session-child')
    expect((refused as Error).message).toContain('Export without subagents instead.')
    // Without subagents the same session exports.
    await expect(assertSessionLogExportable(source, root, false, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('stops measuring when the request is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(assertSessionLogExportable(sources({ [root]: 1 }), root, false, controller.signal)).rejects.toThrow()
  })
})
