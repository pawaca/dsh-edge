import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as EdgeInvariant from '../src/invariant.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('ui-edge package shells', () => {
  it('registers its invariant companion', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(EdgeInvariant).await()).resolves.toBeDefined()
  })

  it('keeps the node half as a no-op host placeholder', async () => {
    const { apply } = await import('../src/index.ts')
    apply()
    expect(true).toBe(true)
  })
})
