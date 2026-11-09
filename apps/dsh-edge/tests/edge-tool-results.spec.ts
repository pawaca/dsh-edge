import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { boundedToolResult, EdgeToolResults, TOOL_RESULT_LIMITS } from '../src/edge-tool-results.ts'

describe('bounded Trajectory results', () => {
  it('counts UTF-8, escaping, structural overhead, nodes and depth before retaining JSON', () => {
    expect(boundedToolResult(null)?.json).toBe('null')
    expect(boundedToolResult({ answer: '中文' })?.bytes).toBe(new TextEncoder().encode('{"answer":"中文"}').length)
    for (const value of ['x'.repeat(TOOL_RESULT_LIMITS.result), '\u0000'.repeat(50000), '😀'.repeat(80000), Array(20000).fill(0)]) expect(boundedToolResult(value)).toBeUndefined()
    let deep: unknown = null
    for (let i = 0; i < 65; i++) deep = [deep]
    expect(boundedToolResult(deep as never)).toBeUndefined()
  })

  it('returns unavailable for oversized and disposed results, preserving JSON null', async () => {
    const ctx = new Context()
    const session = { id: 'one' }
    let live: object | undefined = session
    ctx.provide('sessions', { get: () => live } as never)
    ctx.provide('typert', {} as never)
    const fiber = await ctx.plugin(EdgeToolResults).await()
    const service = ctx.get('sessionToolResults') as unknown as EdgeToolResults
    const abort = new AbortController()
    const watch = service.watch({ sessionId: 'one', seq: 1 } as never, abort.signal)[Symbol.asyncIterator]()
    const exec = { agent: { session }, callId: 'call' }
    expect((await watch.next()).value).toEqual({ available: false })
    ctx.emit('tools/result', exec as never, { isError: false, value: null } as never)
    ctx.emit('session/event', session as never, { type: 'tool/result', seq: 1, data: { message: { toolCallId: 'call' } } } as never)
    expect((await watch.next()).value).toEqual({ available: true, value: null })
    live = undefined
    ctx.emit('session/disposed', session as never)
    expect((await watch.next()).value).toEqual({ available: false })
    abort.abort()
    await watch.return?.()
    await fiber.dispose()
  })
  it('evicts by retained bytes and count across sessions and bounds followers', async () => {
    const ctx = new Context()
    const sessions = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}` }))
    ctx.provide('sessions', { get: (id: string) => sessions.find(session => session.id === id) } as never)
    ctx.provide('typert', {} as never)
    const fiber = await ctx.plugin(EdgeToolResults).await()
    const service = ctx.get('sessionToolResults') as unknown as EdgeToolResults
    const retain = (session: typeof sessions[number], seq: number, value: unknown) => {
      const callId = `call${seq}`
      ctx.emit('tools/result', { agent: { session }, callId } as never, { isError: false, value } as never)
      ctx.emit('session/event', session as never, { type: 'tool/result', seq, data: { message: { toolCallId: callId } } } as never)
    }
    const available = async (session: typeof sessions[number], seq: number) => {
      const abort = new AbortController()
      const stream = service.watch({ sessionId: session.id, seq } as never, abort.signal)[Symbol.asyncIterator]()
      const item = await stream.next()
      abort.abort()
      await stream.return?.()
      return item.done ? false : item.value.available
    }
    try {
      for (const session of sessions) for (let seq = 1; seq <= 5; seq++) retain(session, seq, 'x'.repeat(256 * 1024 - 2))
      // Four values fill each Session; only four such Sessions fit globally.
      expect(await available(sessions[0]!, 5)).toBe(false)
      expect(await available(sessions[5]!, 1)).toBe(false)
      expect(await available(sessions[5]!, 5)).toBe(true)
      for (let seq = 10; seq < 139; seq++) retain(sessions[5]!, seq, null)
      expect(await available(sessions[5]!, 10)).toBe(false)
      expect(await available(sessions[5]!, 138)).toBe(true)
      const abort = new AbortController()
      const watchers = Array.from({ length: 17 }, () => service.watch({ sessionId: sessions[5]!.id, seq: 138 } as never, abort.signal)[Symbol.asyncIterator]())
      const first = await Promise.all(watchers.map(stream => stream.next()))
      expect(first.slice(0, 16).every(item => !item.done && item.value.available)).toBe(true)
      expect(first[16]!.value).toEqual({ available: false })
      abort.abort()
      await Promise.all(watchers.map(async stream => { await stream.return?.() }))
    } finally {
      await fiber.dispose()
    }
  })

})
