import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import * as ApiRemotes from '@deepseek-ai/dsh-api-remotes'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it } from 'vitest'
import { EdgeTypertConnection, type TypertRpcInterceptor } from '../src/edge-typert-connection.ts'

interface WaterfallFrame {
  type: 'waterfall'
  event: string
  eventId: string
  agentId: string
  request: Record<string, unknown>
}

interface EventStream {
  clientId: string
  next(): Promise<unknown>
  close(): void
}

const QUESTION = {
  id: 'deploy',
  question: 'Deploy now?',
  options: [{ label: 'Yes' }, { label: 'No' }],
}

/**
 * The composition the Durable Object installs around user questions: upstream
 * registry, gateway, agents, question seam, and forwarded-event selection, with
 * the Edge connection seam capturing the gateway's RPC interceptor.
 */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(EdgeTypertConnection)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ApiRemotes)
  const session = { id: 'session-1' }
  const agent = { id: 'session-1', session } as { id: string; session: { id: string }; ctx: Context }
  agent.ctx = ctx.extend({ agent })
  const detach = ctx.agents.enter(agent as never, undefined)
  const interceptor = (ctx.get('connection') as EdgeTypertConnection).current()
  if (interceptor === undefined) throw new Error('gateway did not register its interceptor')
  const gateway = ctx.get('typertGateway') as {
    wireStream: { open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> }
  }
  const openEvents = async (): Promise<EventStream> => {
    const abort = new AbortController()
    const stream = await gateway.wireStream.open('$events', { args: {} }, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()
    const ready = (await iterator.next()).value as { type: string; clientId: string; host: { home: string } }
    expect(ready.type).toBe('ready')
    expect(typeof ready.host.home).toBe('string')
    return {
      clientId: ready.clientId,
      next: async () => (await iterator.next()).value as unknown,
      close: () => abort.abort(new Error('socket closed')),
    }
  }
  const answer = (
    stream: EventStream,
    eventId: string,
    outcome: unknown,
  ) => interceptor.dispatch(
    '$events/result',
    { args: { clientId: stream.clientId, eventId, outcome } },
    new AbortController().signal,
  )
  const ask = (signal?: AbortSignal) => ctx.userQuestions.ask({
    questions: [QUESTION],
    agent: agent as never,
    ...signal === undefined ? {} : { signal },
  })
  const dispose = async () => {
    detach()
    await ctx.fiber.dispose()
  }
  return { ctx, agent, interceptor, openEvents, answer, ask, dispose }
}

describe('EdgeTypertConnection', () => {
  it('captures the gateway interceptor for the /api path only', async () => {
    const ctx = new Context()
    await ctx.plugin(EdgeTypertConnection)
    const seam = ctx.get('connection') as EdgeTypertConnection
    expect(seam.current()).toBeUndefined()
    const claims: TypertRpcInterceptor['claims'] = endpoint => endpoint === 'a/b'
    const dispatch: TypertRpcInterceptor['dispatch'] = () => Promise.resolve({ ok: true, value: undefined })
    expect(() => seam.rpc.intercept('/other', claims, dispatch)).toThrow(/unsupported RPC interceptor path/)
    const release = seam.rpc.intercept('/api', claims, dispatch)
    expect(seam.current()?.claims('a/b')).toBe(true)
    expect(() => seam.rpc.intercept('/api', claims, dispatch)).toThrow(/already registered/)
    release()
    expect(seam.current()).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('user questions over the forwarded event stream', () => {
  it('delivers an agent-scoped question and resolves ask() with the browser answer', async () => {
    const h = await harness()
    try {
      expect(h.interceptor.claims('$events/result')).toBe(true)
      expect(h.interceptor.claims('$events/missing')).toBe(false)
      const stream = await h.openEvents()
      const asking = h.ask()
      const frame = await stream.next() as WaterfallFrame
      expect(frame.type).toBe('waterfall')
      expect(frame.event).toBe('user-questions/request')
      expect(frame.agentId).toBe('session-1')
      expect(frame.request).toEqual({ questions: [QUESTION] })
      const answer = { answers: [{ id: 'deploy', selected: ['Yes'] }] }
      const result = await h.answer(stream, frame.eventId, { kind: 'result', value: answer })
      expect(result).toEqual({ ok: true, value: undefined })
      await expect(asking).resolves.toEqual(answer)
      stream.close()
    } finally {
      await h.dispose()
    }
  })

  it('restores the upstream error when the browser closes the question', async () => {
    const h = await harness()
    try {
      const stream = await h.openEvents()
      const asking = h.ask()
      const frame = await stream.next() as WaterfallFrame
      await h.answer(stream, frame.eventId, {
        kind: 'rejected',
        error: { name: 'UserQuestionError', message: 'closed by the user', code: 'ASK_CANCELLED' },
      })
      await expect(asking).rejects.toSatisfy((error: unknown) =>
        error instanceof UserQuestionError && error.code === 'ASK_CANCELLED')
      stream.close()
    } finally {
      await h.dispose()
    }
  })

  it('fails with NO_PROVIDER when the browser delegates and nobody else answers', async () => {
    const h = await harness()
    try {
      const stream = await h.openEvents()
      const asking = h.ask()
      const frame = await stream.next() as WaterfallFrame
      await h.answer(stream, frame.eventId, { kind: 'next' })
      await expect(asking).rejects.toSatisfy((error: unknown) =>
        error instanceof UserQuestionError && error.code === 'NO_PROVIDER')
      stream.close()
    } finally {
      await h.dispose()
    }
  })

  it('cancels the pending delivery when the asking signal aborts', async () => {
    const h = await harness()
    try {
      const stream = await h.openEvents()
      const abort = new AbortController()
      const asking = h.ask(abort.signal)
      const frame = await stream.next() as WaterfallFrame
      abort.abort(new Error('turn cancelled'))
      await expect(asking).rejects.toSatisfy((error: unknown) =>
        error instanceof UserQuestionError && error.code === 'ASK_ABORTED')
      expect(await stream.next()).toEqual({ type: 'cancel', eventId: frame.eventId })
      const late = await h.answer(stream, frame.eventId, { kind: 'result', value: { answers: [] } })
      expect(late).toEqual({ ok: true, value: undefined })
      stream.close()
    } finally {
      await h.dispose()
    }
  })

  it('keeps a question pending across a dropped socket and redelivers it on reconnect', async () => {
    const h = await harness()
    try {
      const asking = h.ask()
      const first = await h.openEvents()
      const frame = await first.next() as WaterfallFrame
      first.close()
      expect(await first.next()).toBeUndefined()
      const second = await h.openEvents()
      const redelivered = await second.next() as WaterfallFrame
      expect(redelivered).toEqual(frame)
      const stale = await h.answer(first, frame.eventId, { kind: 'result', value: { answers: [] } })
      expect(stale).toMatchObject({ ok: false })
      const answer = { answers: [{ id: 'deploy', selected: ['No'] }] }
      await h.answer(second, frame.eventId, { kind: 'result', value: answer })
      await expect(asking).resolves.toEqual(answer)
      second.close()
    } finally {
      await h.dispose()
    }
  })

  it('reports malformed results as RPC failures instead of throwing', async () => {
    const h = await harness()
    try {
      const result = await h.interceptor.dispatch('$events/result', { args: { nope: true } }, new AbortController().signal)
      expect(result).toMatchObject({ ok: false, error: { code: expect.any(String) as unknown } })
    } finally {
      await h.dispose()
    }
  })
})
