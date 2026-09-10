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
import { createDurablePromptAdmitter, disposeAgentHandle, EdgeAgentPresets } from '../src/session-store.ts'

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

describe('dsh-edge subagent delegation', () => {
  async function subagentHarness(replies: readonly (readonly StreamChunk[])[], shell: EdgeShell) {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: EDGE_SYSTEM_PROMPT })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EdgeAgentPresets)

    const { default: SubagentRuntime } = await import('@deepseek-ai/dsh-subagent')
    await ctx.plugin(SubagentRuntime)
    const SpawnInProcess = await import('@deepseek-ai/dsh-subagent-spawn-in-process')
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    const ToolSubagent = await import('@deepseek-ai/dsh-tool-subagent')
    await ctx.plugin(ToolSubagent, {
      provider: 'spawn',
      maxDepth: 1,
      enableRunInBackground: false,
    })

    const adapter = new ScriptedAdapter(replies)
    const shells = new EdgeShellBindings()
    ctx.llm.registerAdapter(['deepseek-official'], adapter)
    ctx.tools.register(createEdgeBashTool(shells))

    const childHeaders: { id: string; parentSession: string; agentPreset: string | undefined }[] = []
    ctx.on('agent/created', ({ agent }) => {
      const parentId = agent.session.header.parentSession
      if (parentId === undefined) return
      childHeaders.push({
        id: agent.session.header.id as string,
        parentSession: parentId as string,
        agentPreset: agent.session.header.agentPreset,
      })
      const parentShell = shells.get(parentId)
      if (parentShell === undefined) return
      const cwd = agent.session.header.cwd ?? parentShell.cwd
      const release = shells.bind(agent.id, parentShell.shell, cwd)
      agent.ctx.effect(() => release, 'test: subagent shell binding')
    })

    const sessionId = SessionId(crypto.randomUUID())
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: '/workspace', agentPreset: 'dsh-edge' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const { agent } = handle
    const events: SessionEvent[] = []
    ctx.on('session/event', (_subject, event) => { events.push(event) })
    const releaseShell = shells.bind(sessionId, shell, '/workspace')
    return { ctx, agent, handle, adapter, shells, events, childHeaders, releaseShell }
  }

  it('registers the subagent tool alongside bash', async () => {
    const runtime = await subagentHarness([], { exec: vi.fn<EdgeShell['exec']>() })
    try {
      expect(runtime.ctx.tools.get('subagent')).toBeDefined()
      expect(runtime.ctx.tools.get('bash')).toBeDefined()
    } finally {
      runtime.releaseShell()
      await runtime.ctx.fiber.dispose()
    }
  })

  it('delegates a one-shot subagent call and returns the child output', async () => {
    const subagentCallId = ToolCallId('call-subagent')
    const childReply = textReply('child result: file created', 10, 8)
    const parentFollowup = textReply('Done. The subagent created the file.', 20, 12)

    const exec = vi.fn<EdgeShell['exec']>()
    const runtime = await subagentHarness([
      toolReply(subagentCallId, 'subagent', {
        description: 'Create a file',
        prompt: 'Create /workspace/test.txt with content hello',
      }),
      childReply,
      parentFollowup,
    ], { exec })
    try {
      await followup(runtime.agent, 'Create a test file using a subagent')
      expect(runtime.adapter.requests.length).toBeGreaterThanOrEqual(2)
      const toolCall = runtime.events.find(
        e => e.type === 'tool/call' && (e.data as { name?: string }).name === 'subagent',
      )
      expect(toolCall).toBeDefined()
      const callId = (toolCall!.data as { callId: string }).callId
      const toolResult = runtime.events.find(
        e => e.type === 'tool/result'
          && ((e.data as { message?: { source?: { callId?: string } } }).message?.source?.callId === callId),
      )
      expect(toolResult).toBeDefined()
      const resultContent = (toolResult!.data as {
        message: { content: { isError: boolean }[] }
      }).message.content[0]!
      expect(resultContent.isError).toBe(false)
      expect(runtime.childHeaders.length).toBeGreaterThanOrEqual(1)
      expect(runtime.childHeaders[0]).toMatchObject({
        parentSession: runtime.agent.session.header.id,
        agentPreset: 'dsh-edge',
      })
      const childRequest = runtime.adapter.requests[1]!
      expect(childRequest.sessionId).not.toBe(runtime.agent.id)
      expect(childRequest.tools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'bash' })]),
      )
    } finally {
      runtime.releaseShell()
      await runtime.ctx.fiber.dispose()
    }
  })

  it('binds the parent shell to a child agent automatically', async () => {
    const shell: EdgeShell = { exec: vi.fn<EdgeShell['exec']>() }
    const runtime = await subagentHarness([], shell)
    try {
      const childId = SessionId('child-test')
      const childShellRelease = runtime.shells.bind(childId, shell, '/workspace')
      expect(runtime.shells.get(childId)).toBeDefined()
      expect(runtime.shells.get(childId)?.shell).toBe(shell)
      childShellRelease()
      expect(runtime.shells.get(childId)).toBeUndefined()
    } finally {
      runtime.releaseShell()
      await runtime.ctx.fiber.dispose()
    }
  })

  it('exposes EdgeShellBindings.get() for parent lookup', () => {
    const shells = new EdgeShellBindings()
    const id = SessionId('test-session')
    expect(shells.get(id)).toBeUndefined()
    const mockShell: EdgeShell = { exec: vi.fn<EdgeShell['exec']>() }
    const release = shells.bind(id, mockShell, '/workspace')
    expect(shells.get(id)).toEqual({ shell: mockShell, cwd: '/workspace' })
    release()
    expect(shells.get(id)).toBeUndefined()
  })
})

describe('dsh-edge background job registry', () => {
  async function bgHarness(replies: readonly (readonly StreamChunk[])[], shell: EdgeShell) {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: EDGE_SYSTEM_PROMPT })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EdgeAgentPresets)

    const { default: LocalJobRegistry } = await import('@deepseek-ai/dsh-jobs-local')
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 3 })
    const ToolJobs = await import('@deepseek-ai/dsh-tool-jobs')
    await ctx.plugin(ToolJobs)

    const { default: SubagentRuntime } = await import('@deepseek-ai/dsh-subagent')
    await ctx.plugin(SubagentRuntime)
    const SpawnInProcess = await import('@deepseek-ai/dsh-subagent-spawn-in-process')
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    const ToolSubagent = await import('@deepseek-ai/dsh-tool-subagent')
    await ctx.plugin(ToolSubagent, {
      provider: 'spawn',
      maxDepth: 1,
      enableRunInBackground: true,
    })

    const adapter = new ScriptedAdapter(replies)
    const shells = new EdgeShellBindings()
    ctx.llm.registerAdapter(['deepseek-official'], adapter)
    ctx.tools.register(createEdgeBashTool(shells))

    ctx.on('agent/created', ({ agent }) => {
      const parentId = agent.session.header.parentSession
      if (parentId === undefined) return
      const parentShell = shells.get(parentId)
      if (parentShell === undefined) return
      const cwd = agent.session.header.cwd ?? parentShell.cwd
      const release = shells.bind(agent.id, parentShell.shell, cwd)
      agent.ctx.effect(() => release, 'test: subagent shell binding')
    })

    const sessionId = SessionId(crypto.randomUUID())
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: '/workspace', agentPreset: 'dsh-edge' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const { agent } = handle
    const events: SessionEvent[] = []
    ctx.on('session/event', (_subject, event) => { events.push(event) })
    const releaseShell = shells.bind(sessionId, shell, '/workspace')
    return { ctx, agent, handle, adapter, shells, events, releaseShell }
  }

  it('registers job tools alongside subagent and bash', async () => {
    const runtime = await bgHarness([], { exec: vi.fn<EdgeShell['exec']>() })
    try {
      expect(runtime.ctx.tools.get('subagent')).toBeDefined()
      expect(runtime.ctx.tools.get('bash')).toBeDefined()
      expect(runtime.ctx.tools.get('job_output')).toBeDefined()
      expect(runtime.ctx.tools.get('job_list')).toBeDefined()
      expect(runtime.ctx.tools.get('job_kill')).toBeDefined()
      expect(runtime.ctx.get('jobs')).toBeDefined()
    } finally {
      runtime.releaseShell()
      await runtime.ctx.fiber.dispose()
    }
  })

  it('dispatches a background subagent and collects the completion', async () => {
    const bgCallId = ToolCallId('call-bg-sub')
    const childReply = textReply('background result', 10, 8)
    const jobOutputCallId = ToolCallId('call-job-output')
    const parentDone = textReply('Done, collected the result.', 20, 12)

    const exec = vi.fn<EdgeShell['exec']>()
    const runtime = await bgHarness([
      toolReply(bgCallId, 'subagent', {
        description: 'Background task',
        prompt: 'Do something in the background',
        run_in_background: true,
      }),
      childReply,
      toolReply(jobOutputCallId, 'job_output', {
        job_id: 'subagent-1',
        wait: true,
      }),
      parentDone,
    ], { exec })
    try {
      await followup(runtime.agent, 'Run a background subagent')
      const toolCall = runtime.events.find(
        e => e.type === 'tool/call' && (e.data as { name?: string }).name === 'subagent',
      )
      expect(toolCall).toBeDefined()
      const toolResult = runtime.events.filter(e => e.type === 'tool/result')
      expect(toolResult.length).toBeGreaterThanOrEqual(1)
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
