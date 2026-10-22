import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { EdgeSettings } from '../src/edge-settings.ts'
import { SHELL_SETTINGS_NAMESPACE, installEdgeShellSettings, liveTimeoutPolicy } from '../src/edge-shell-settings.ts'

function memoryStorage(): DurableObjectStorage {
  const store = new Map<string, unknown>()
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
    delete: (key: string) => Promise.resolve(store.delete(key)),
  } as unknown as DurableObjectStorage
}

describe('Shell card settings', () => {
  const policy = { defaultTimeoutMs: 120_000, maxTimeoutMs: 240_000 }

  async function scope(storage = memoryStorage()) {
    const ctx = new Context()
    await ctx.plugin(EdgeSettings, { storage })
    return { ctx, storage, shell: installEdgeShellSettings(ctx, policy) }
  }

  it('defaults to the deployment timeout and upstream\'s 64,000-byte cap on upstream\'s namespace', async () => {
    const { ctx, shell } = await scope()
    try {
      expect(SHELL_SETTINGS_NAMESPACE).toBe('bash-sandbox')
      expect(shell.get()).toEqual({ timeoutMs: 120_000, maxOutputBytes: 64_000 })
      expect(liveTimeoutPolicy(policy, shell.get())).toEqual(policy)
    } finally { await ctx.fiber.dispose() }
  })

  it('saves values within the deployment ceiling and the memory bound, and refuses others', async () => {
    const { ctx, storage, shell } = await scope()
    try {
      await shell.update({ timeoutMs: 200_000, maxOutputBytes: 4_096 })
      expect(liveTimeoutPolicy(policy, shell.get())).toEqual({ defaultTimeoutMs: 200_000, maxTimeoutMs: 240_000 })
      await expect(shell.update({ timeoutMs: 240_001 })).rejects.toThrow(/from 1 to 240000/u)
      await expect(shell.update({ timeoutMs: 1.5 })).rejects.toThrow(/whole number/u)
      await expect(shell.update({ maxOutputBytes: 1_023 })).rejects.toThrow(/from 1024 to 1048576/u)
      await expect(shell.update({ maxOutputBytes: 1_048_577 })).rejects.toThrow(/from 1024 to 1048576/u)
      expect(shell.get()).toEqual({ timeoutMs: 200_000, maxOutputBytes: 4_096 })
      await ctx.fiber.dispose()
      // A deployment that lowered its ceiling below a saved timeout falls back to the defaults.
      const lowered = new Context()
      await lowered.plugin(EdgeSettings, { storage })
      const reread = installEdgeShellSettings(lowered, { defaultTimeoutMs: 60_000, maxTimeoutMs: 90_000 })
      expect(reread.get()).toEqual({ timeoutMs: 60_000, maxOutputBytes: 64_000 })
      await lowered.fiber.dispose()
    } finally { await ctx.fiber.dispose() }
  })
})
