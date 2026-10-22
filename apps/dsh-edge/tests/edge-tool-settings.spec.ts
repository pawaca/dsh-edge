import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import DurableObjectSessionPersistence from '../src/do-session-persistence.ts'
import EdgeSessionQuery from '../src/edge-session-query.ts'
import { EdgeSettings } from '../src/edge-settings.ts'
import { installEdgeToolSettings, parseToolSettingsPatch } from '../src/edge-tool-settings.ts'
import { TestDurableObjectStorage } from './main-session-queue.spec.ts'

function memoryStorage(): DurableObjectStorage {
  const store = new Map<string, unknown>()
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
    delete: (key: string) => Promise.resolve(store.delete(key)),
  } as unknown as DurableObjectStorage
}

const SESSION_TOOLS = ['session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace']

describe('optional tool settings', () => {
  async function harness(settingsStorage = memoryStorage()) {
    const storage = new TestDurableObjectStorage()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never }).await()
    await ctx.plugin(EdgeSessionQuery)
    await ctx.plugin(EdgeSettings, { storage: settingsStorage })
    const tools = await installEdgeToolSettings(ctx)
    const offered = () => SESSION_TOOLS.filter(name => ctx.tools.get(name) !== undefined)
    return { ctx, storage, settingsStorage, tools, offered }
  }

  it('mounts the session-query tools only while the switch is on, applied once sync resolves', async () => {
    const { ctx, storage, settingsStorage, tools, offered } = await harness()
    try {
      expect(tools.scope.get()).toEqual({ sessionQuery: false })
      expect(offered()).toEqual([])
      await tools.scope.update({ sessionQuery: true })
      await tools.sync()
      expect(offered()).toEqual(SESSION_TOOLS)
      await tools.scope.update({ sessionQuery: false })
      await tools.sync()
      expect(offered()).toEqual([])
      await tools.scope.update({ sessionQuery: true })
      await tools.sync()
    } finally { await ctx.fiber.dispose(); storage.close() }
    // A restart mounts them from the saved setting.
    const restarted = await harness(settingsStorage)
    try {
      expect(restarted.offered()).toEqual(SESSION_TOOLS)
    } finally { await restarted.ctx.fiber.dispose(); restarted.storage.close() }
  })

  it('reports a failed mount from sync and retries it on the next application', async () => {
    const ctx = new Context()
    await ctx.plugin(EdgeSettings, { storage: memoryStorage() })
    let attempts = 0
    const plugin = {
      name: 'flaky-tools',
      apply() {
        attempts++
        if (attempts === 1) throw new Error('mount failed')
      },
    }
    const tools = await installEdgeToolSettings(ctx, () => Promise.resolve(plugin as never))
    try {
      await tools.scope.update({ sessionQuery: true })
      // The watcher's attempt failed; sync retries it and succeeds, rather than reporting a no-op.
      await expect(tools.sync()).resolves.toBeUndefined()
      expect(attempts).toBe(2)
    } finally { await ctx.fiber.dispose() }
    const failing = new Context()
    await failing.plugin(EdgeSettings, { storage: memoryStorage() })
    const broken = await installEdgeToolSettings(failing, () => Promise.resolve({ name: 'broken', apply() { throw new Error('mount failed') } } as never))
    try {
      await broken.scope.update({ sessionQuery: true })
      await expect(broken.sync()).rejects.toThrow('mount failed')
    } finally { await failing.fiber.dispose() }
  })

  it('retries a mount that failed at start before the next turn', async () => {
    const storage = memoryStorage()
    const first = new Context()
    await first.plugin(EdgeSettings, { storage })
    await (await installEdgeToolSettings(first, () => Promise.resolve({ name: 'ok', apply() {} } as never))).scope.update({ sessionQuery: true })
    await first.fiber.dispose()
    // A restart whose start-up mount fails keeps the saved "on" and recovers on ensure().
    const ctx = new Context()
    await ctx.plugin(EdgeSettings, { storage })
    let attempts = 0
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tools = await installEdgeToolSettings(ctx, () => Promise.resolve({
      name: 'flaky',
      apply() { attempts++; if (attempts === 1) throw new Error('mount failed') },
    } as never))
    try {
      expect(attempts).toBe(1)
      expect(tools.scope.get().sessionQuery).toBe(true)
      await tools.ensure()
      expect(attempts).toBe(2)
      await tools.ensure()
      expect(attempts).toBe(2)
    } finally {
      error.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('accepts only a boolean sessionQuery', () => {
    expect(parseToolSettingsPatch({ sessionQuery: true })).toEqual({ sessionQuery: true })
    expect(parseToolSettingsPatch({ sessionQuery: 'yes' })).toBe('sessionQuery must be a boolean')
    expect(parseToolSettingsPatch({ other: true })).toBe('unknown setting: other')
    expect(parseToolSettingsPatch([])).toBe('body must be an object')
  })
})
