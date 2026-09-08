import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { installScheduleTools } from '../src/schedule-store.ts'

it('retains upstream exclusive classification for native and nested schedule calls', async () => {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} } as never)
  const tools = new ToolRuntime(ctx)
  const agent = { ctx } as Agent
  const dispose = installScheduleTools(ctx, agent, {} as DurableObjectStorage)
  try {
    for (const name of ['schedule_create', 'schedule_list', 'schedule_delete']) {
      expect(tools.get(name, agent)).toBeDefined()
      expect(tools.executionMode({ name, callId: ToolCallId(name), arguments: {}, signal: new AbortController().signal, agent })).toEqual({ kind: 'exclusive' })
      expect(tools.executionMode({ name, callId: ToolCallId(name), arguments: {}, signal: new AbortController().signal, agent, parent: {} as never })).toEqual({ kind: 'exclusive' })
    }
  } finally { dispose(); await ctx.fiber.dispose() }
})
