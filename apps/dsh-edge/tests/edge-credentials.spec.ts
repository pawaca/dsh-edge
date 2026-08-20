import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import EdgeCredentialProvider, {
  EDGE_DEEPSEEK_API_KEY_REF,
} from '../src/edge-credentials.ts'

describe('dsh-edge credential provider', () => {
  it('resolves the current Worker secret without making it writable', async () => {
    const ctx = new Context()
    let apiKey: string | undefined = 'first-key'
    await ctx.plugin(EdgeCredentialProvider, { readDeepSeekApiKey: () => apiKey })
    try {
      expect(await ctx.credentials.resolve(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        value: 'first-key',
        source: 'worker-secret',
      })
      expect(await ctx.credentials.describe(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        configured: true,
        source: 'worker-secret',
        writable: false,
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
        writable: false,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports unsupported and absent references without creating a store', async () => {
    const ctx = new Context()
    await ctx.plugin(EdgeCredentialProvider, { readDeepSeekApiKey: () => undefined })
    try {
      expect(await ctx.credentials.resolve(credentialRef('OTHER_KEY'))).toBeUndefined()
      expect(await ctx.credentials.describe(EDGE_DEEPSEEK_API_KEY_REF)).toEqual({
        configured: false,
        writable: false,
      })
      await expect(ctx.credentials.set(EDGE_DEEPSEEK_API_KEY_REF, 'new-key'))
        .rejects.toThrow(/read-only/u)
      await expect(ctx.credentials.unset(EDGE_DEEPSEEK_API_KEY_REF))
        .rejects.toThrow(/read-only/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
