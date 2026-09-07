import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  ToolCallId,
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  EDGE_SYSTEM_PROMPT,
  EdgeShellBindings,
  createEdgeBashTool,
  type EdgeShell,
} from '../src/agent.ts'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import {
  resolveEdgeBaseURL,
  resolveEdgeMaxOutputTokens,
  resolveEdgeModel,
  resolveEdgeReasoningEffort,
  resolveEdgeStreamIdleTimeoutMs,
} from '../src/deepseek.ts'
import { EdgeExecutionId } from '../src/protocol.ts'
import { createDurablePromptAdmitter, disposeAgentHandle } from '../src/session-store.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly replies: readonly (readonly StreamChunk[])[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 8_192,
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ ...options, messages: structuredClone(options.messages) })
    const reply = this.replies[this.requests.length - 1]
    if (reply === undefined) throw new Error('ScriptedAdapter ran out of replies')
    for (const chunk of reply) yield chunk
  }
}

async function harness(replies: readonly (readonly StreamChunk[])[], shell: EdgeShell) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: EDGE_SYSTEM_PROMPT })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })

  const adapter = new ScriptedAdapter(replies)
  const shells = new EdgeShellBindings()
  ctx.llm.registerAdapter(['deepseek-official'], adapter)
  ctx.tools.register(createEdgeBashTool(shells))

  const sessionId = SessionId(crypto.randomUUID())
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: '/workspace', agentPreset: 'dsh-edge' },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  const { agent } = handle
  const events: SessionEvent[] = []
  ctx.on('session/event', (subject, event) => {
    if (subject === agent.session) events.push(event)
  })
  const releaseShell = shells.bind(sessionId, shell, '/workspace')
  return { ctx, agent, handle, adapter, events, releaseShell }
}

async function followup(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

describe('dsh-edge native agent runtime', () => {
  it('releases the Edge owner only after upstream teardown settles, including failure', async () => {
    const { ctx, agent, handle, releaseShell } = await harness([], { exec: vi.fn<EdgeShell['exec']>() })
    const gate = Promise.withResolvers<void>()
    const nativeDispose = handle.dispose.bind(handle)
    const failure = new Error('injected teardown failure')
    // Inject a teardown failure after real upstream scope disposal. The factory
    // must still detach both registry entries in its finally boundary.
    const scope = (agent as Agent & { scope: { dispose(): Promise<void> } }).scope
    const scopeDispose = scope.dispose.bind(scope)
    vi.spyOn(scope, 'dispose').mockImplementation(async () => {
      await gate.promise
      await scopeDispose()
      throw failure
    })
    const released = vi.fn(() => {
      expect(ctx.agents.get(agent.id)).toBeUndefined()
      expect(ctx.sessions.get(agent.session.id)).toBeUndefined()
    })
    const closing = disposeAgentHandle(handle, released)
    const assertion = expect(closing).rejects.toBe(failure)
    await Promise.resolve()
    expect(released).not.toHaveBeenCalled()
    expect(ctx.agents.get(agent.id)).toBe(agent)
    gate.resolve()
    await assertion
    expect(released).toHaveBeenCalledOnce()
    await expect(nativeDispose()).rejects.toBe(failure)
    releaseShell()
    await ctx.fiber.dispose()
  })

  it('advertises dedicated Edge tools without routing file work through bash', () => {
    expect(EDGE_SYSTEM_PROMPT).toContain('read, write, and edit tools')
    expect(EDGE_SYSTEM_PROMPT).toContain('read_image')
    expect(EDGE_SYSTEM_PROMPT).toContain('Use bash for shell commands')
    expect(EDGE_SYSTEM_PROMPT).toContain('web_search and web_fetch')
    expect(EDGE_SYSTEM_PROMPT).toContain('goal tools')
    expect(EDGE_SYSTEM_PROMPT).not.toContain(
      'Use the bash tool when you need to inspect or modify workspace files',
    )
  })

  it('reuses the upstream DeepSeek catalog including the experimental vision model', async () => {
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({}),
      resolveApiKey: async (_connection) => 'test-key',
      resolveUserId: () => 'test-user' as never,
      prepareExtensions: async () => ({}) as never,
    })
    const models = await adapter.listModels('deepseek-official')

    expect(models.map(model => model.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
    ])
    await expect(adapter.resolveModel(
      'deepseek-official',
      'deepseek-v4-flash-vision-exp',
    )).resolves.toMatchObject({ inputModalities: ['text', 'image'] })
  })

  it('validates the deployment stream idle timeout', () => {
    expect(resolveEdgeStreamIdleTimeoutMs()).toBe(120_000)
    expect(resolveEdgeStreamIdleTimeoutMs('600000')).toBe(600_000)
    expect(() => resolveEdgeStreamIdleTimeoutMs('0')).toThrow(/positive integer/)
    expect(() => resolveEdgeStreamIdleTimeoutMs('1.5')).toThrow(/positive integer/)
    expect(() => resolveEdgeStreamIdleTimeoutMs('2147483648')).toThrow(/no greater/)
  })

  it('validates the deployment model output cap', () => {
    expect(resolveEdgeMaxOutputTokens()).toBe(256_000)
    expect(resolveEdgeMaxOutputTokens('32768')).toBe(32_768)
    expect(() => resolveEdgeMaxOutputTokens('0')).toThrow(/positive integer/)
    expect(() => resolveEdgeMaxOutputTokens('1.5')).toThrow(/positive integer/)
    expect(() => resolveEdgeMaxOutputTokens('9007199254740992')).toThrow(/no greater/)
  })

  it('validates the deployment model and reasoning policy', () => {
    expect(resolveEdgeBaseURL()).toBe('https://api.deepseek.com')
    expect(resolveEdgeBaseURL('http://127.0.0.1:9797/v1')).toBe('http://127.0.0.1:9797/v1')
    expect(() => resolveEdgeBaseURL('http://[')).toThrow(/valid HTTP\(S\) URL/)
    expect(() => resolveEdgeBaseURL('file:///tmp/api')).toThrow(/valid HTTP\(S\) URL/)
    expect(() => resolveEdgeBaseURL('https://key@example.com')).toThrow(/without credentials/)
    expect(resolveEdgeModel()).toBe('deepseek-v4-flash')
    expect(resolveEdgeModel('deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(() => resolveEdgeModel('bad model')).toThrow(/valid model id/)
    expect(() => resolveEdgeModel('x'.repeat(129))).toThrow(/valid model id/)
    expect(resolveEdgeReasoningEffort()).toBe('high')
    expect(resolveEdgeReasoningEffort('low')).toBe('low')
    expect(resolveEdgeReasoningEffort('high')).toBe('high')
    expect(resolveEdgeReasoningEffort('max')).toBe('max')
    expect(() => resolveEdgeReasoningEffort('medium')).toThrow(/off, low, high, or max/)
  })

  it('drives a direct answer through upstream ReactLoopAgent events', async () => {
    const exec = vi.fn<EdgeShell['exec']>()
    const runtime = await harness([textReply('hello from edge', 7, 4)], { exec })
    try {
      await followup(runtime.agent, 'hello')

      expect(exec).not.toHaveBeenCalled()
      expect(runtime.adapter.requests[0]).toMatchObject({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        sessionId: runtime.agent.id,
        tools: [{ name: 'bash' }],
      })
      expect(runtime.events.map(event => event.type)).toEqual(expect.arrayContaining([
        'turn/start',
        'step/start',
        'user/message',
        'request/header',
        'request/context',
        'assistant/chunk',
        'assistant/message',
        'step/end',
        'turn/end',
      ]))
      expect(runtime.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      runtime.releaseShell()
      await runtime.ctx.fiber.dispose()
    }
  })

  it('accepts an enqueued prompt but blocks model use when its durability barrier fails', async () => {
    const exec = vi.fn<EdgeShell['exec']>()
    const runtime = await harness([textReply('must not run', 7, 4)], { exec })
    const admission = createDurablePromptAdmitter(
      runtime.ctx,
      runtime.agent,
      vi.fn().mockRejectedValue(new Error('simulated persistence failure')),
    )
    try {
      await expect(admission.admit({
        mode: 'queue',
        content: [{ type: 'text', text: 'do not spend model quota' }],
      })).resolves.toEqual({ durable: false })
      await runtime.agent.whenIdle()

      expect(runtime.adapter.requests).toHaveLength(0)
      expect(runtime.events.some(event => event.type === 'user/message')).toBe(false)
      expect(runtime.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'blocked' } },
      })
    } finally {
      admission.dispose()
      runtime.releaseShell()
      await runtime.ctx.fiber.dispose()
    }
  })

  it('executes a native tool call through the session-bound Computer shell', async () => {
    const callId = ToolCallId('call-read-file')
    const exec = vi.fn<EdgeShell['exec']>().mockResolvedValue({
      executionId: EdgeExecutionId('exec-1'),
      status: 'completed',
      timedOut: false,
      exitCode: 0,
      stdout: 'hello from the VFS.\n',
      stderr: '',
      outputTruncated: false,
    })
    const runtime = await harness([
      toolReply(callId, 'bash', {
        command: 'cat /workspace/hello.txt',
        description: 'Read the file',
      }),
      textReply('The file says hello.', 15, 8),
    ], { exec })
    try {
      await followup(runtime.agent, 'Read hello.txt')

      expect(exec).toHaveBeenCalledOnce()
      const [command, options] = exec.mock.calls[0] ?? []
      expect(command).toBe('cat /workspace/hello.txt')
      expect(options?.cwd).toBe('/workspace')
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      expect(runtime.adapter.requests).toHaveLength(2)
      expect(runtime.adapter.requests[1]?.messages).toMatchObject([
        { role: 'user' },
        { role: 'assistant', content: [{ type: 'tool-call', id: callId }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, isError: false }] },
      ])
      expect(runtime.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
      expect(runtime.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
      expect(runtime.events.filter(event => event.type === 'step/start')).toHaveLength(2)
    } finally {
      runtime.releaseShell()
      await runtime.ctx.fiber.dispose()
    }
  })
})

function textReply(text: string, inputTokens: number, outputTokens: number): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens, outputTokens } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolReply(callId: ToolCallId, name: string, args: object): StreamChunk[] {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
