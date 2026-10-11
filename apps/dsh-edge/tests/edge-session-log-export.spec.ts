import { SessionId } from '@deepseek-ai/dsh-session'
import { streamSessionLogZip } from '@deepseek-ai/dsh-session-log-export'
import { describe, expect, it, vi } from 'vitest'
import {
  assertSessionLogExportable,
  enforceSessionLogExportBudget,
  MAX_SESSION_LOG_EXPORT_BYTES,
  sessionLogExportBudget,
  SessionLogTooLargeError,
  type SessionLogExportBudget,
  type SessionLogExportSources,
} from '../src/edge-session-log-export.ts'
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

  describe('read budget inside the real upstream exporter', () => {
    // The exporter reads each subagent log from a stream callback that starts inside
    // the request but runs after the handler has returned, so the budget must travel
    // through the stream's async continuations. This runs upstream's own
    // `streamSessionLogZip` with a persistence whose read enforces the budget the way
    // the Edge's does.
    const run = (withBudget: boolean) => {
      const budget: SessionLogExportBudget = { limitBytes: 1_000 }
      const deps = {
        sessionQuery: { traceSession: () => Promise.resolve({ descendants: [{ session: { header: { id: child } }, descendants: [] }] }) },
        sessionPersistence: {
          open: (id: ReturnType<typeof SessionId>) => Promise.resolve({
            header: { version: 4, id, createdAt: 1, isSeeded: false },
            read: () => {
              enforceSessionLogExportBudget(id, () => 5_000)
              return Promise.resolve({ events: [] })
            },
            close: () => Promise.resolve(),
          }),
        },
        attachments: {},
        sessions: undefined,
      }
      const start = () => streamSessionLogZip(deps as never, '{"type":"session"}\n', root, true, 6, new AbortController().signal)
      const stream = withBudget ? sessionLogExportBudget.run(budget, start) : start()
      // Drained after run() returned: the subagent read happens later.
      const drained = (async () => {
        const reader = stream.getReader()
        for (;;) if ((await reader.read()).done) return 'completed' as const
      })().catch((error: unknown) => error)
      return { budget, drained }
    }

    it('refuses an over-budget subagent log read while the archive streams', async () => {
      const { budget, drained } = run(true)
      expect(await drained).toBeInstanceOf(SessionLogTooLargeError)
      expect(budget.refused?.sessionId).toBe(child)
    })

    it('does not touch the same export outside a budgeted request', async () => {
      const { budget, drained } = run(false)
      expect(await drained).toBe('completed')
      expect(budget.refused).toBeUndefined()
    })
  })
})
