import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import EdgeCredentialProvider, {
  EDGE_DEEPSEEK_API_KEY_REF,
} from '../src/edge-credentials.ts'

function createMockStorage(): DurableObjectStorage {
  const store = new Map<string, unknown>()
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
    delete: (key: string) => { store.delete(key); return Promise.resolve(true) },
  } as unknown as DurableObjectStorage
}

describe('dsh-edge credential provider', () => {
  it('resolves from worker env when DO storage is empty', async () => {
    const ctx = new Context()
    let apiKey: string | undefined = 'first-key'
    const storage = createMockStorage()
    await ctx.plugin(EdgeCredentialProvider, { storage, readDeepSeekApiKey: () => apiKey })
    try {
      expect(await ctx.credentials.resolve(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        value: 'first-key',
        source: 'worker-secret',
      })
      expect(await ctx.credentials.describe(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        configured: true,
        source: 'worker-secret',
        writable: true,
      })

      apiKey = 'rotated-key'
      expect(await ctx.credentials.resolve(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        value: 'rotated-key',
        source: 'worker-secret',
      })

      apiKey = '  padded-key  '
      expect(await ctx.credentials.resolve(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        value: 'padded-key',
        source: 'worker-secret',
      })

      apiKey = '   '
      expect(await ctx.credentials.resolve(EDGE_DEEPSEEK_API_KEY_REF)).toBeUndefined()
      expect(await ctx.credentials.describe(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        configured: false,
        writable: true,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves unknown refs from DO storage only', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(EdgeCredentialProvider, { storage, readDeepSeekApiKey: () => 'env-key' })
    try {
      const otherRef = credentialRef('OTHER_KEY')
      expect(await ctx.credentials.resolve(otherRef)).toBeUndefined()

      await ctx.credentials.set(otherRef, 'stored-other')
      expect(await ctx.credentials.resolve(otherRef)).toEqual({
        value: 'stored-other',
        source: 'do-storage',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('prefers DO storage over worker env when both exist', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(EdgeCredentialProvider, { storage, readDeepSeekApiKey: () => 'env-key' })
    try {
      await ctx.credentials.set(EDGE_DEEPSEEK_API_KEY_REF, 'do-key')
      expect(await ctx.credentials.resolve(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        value: 'do-key',
        source: 'do-storage',
      })
      expect(await ctx.credentials.describe(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        configured: true,
        source: 'do-storage',
        writable: true,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to worker env after DO storage value is unset', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(EdgeCredentialProvider, { storage, readDeepSeekApiKey: () => 'env-key' })
    try {
      await ctx.credentials.set(EDGE_DEEPSEEK_API_KEY_REF, 'do-key')
      expect(await ctx.credentials.resolve(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        value: 'do-key',
        source: 'do-storage',
      })

      await ctx.credentials.unset(EDGE_DEEPSEEK_API_KEY_REF)
      expect(await ctx.credentials.resolve(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        value: 'env-key',
        source: 'worker-secret',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects set with empty value', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(EdgeCredentialProvider, { storage, readDeepSeekApiKey: () => undefined })
    try {
      await expect(ctx.credentials.set(EDGE_DEEPSEEK_API_KEY_REF, ''))
        .rejects.toThrow(/empty/u)
      await expect(ctx.credentials.set(EDGE_DEEPSEEK_API_KEY_REF, '   '))
        .rejects.toThrow(/empty/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('describes unconfigured when neither DO nor env has a value', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(EdgeCredentialProvider, { storage, readDeepSeekApiKey: () => undefined })
    try {
      expect(await ctx.credentials.describe(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        configured: false,
        writable: true,
      })
      expect(await ctx.credentials.describe(credentialRef('OTHER_KEY'))).toEqual({
        configured: false,
        writable: true,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('treats stored empty string as absent', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await storage.put('dsh-edge:credential:DEEPSEEK_API_KEY', '  ')
    await ctx.plugin(EdgeCredentialProvider, { storage, readDeepSeekApiKey: () => 'env-key' })
    try {
      expect(await ctx.credentials.resolve(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        value: 'env-key',
        source: 'worker-secret',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
