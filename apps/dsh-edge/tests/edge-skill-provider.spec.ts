import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import * as EdgeSkillProvider from '../src/edge-skill-provider.ts'
import { putSkill, deleteSkill, listSkillNames } from '../src/edge-skill-provider.ts'

function createMockStorage(): DurableObjectStorage & { readonly store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
    delete: (key: string) => {
      const had = store.has(key)
      store.delete(key)
      return Promise.resolve(had)
    },
    list: (opts?: { prefix?: string }) => {
      const result = new Map<string, unknown>()
      for (const [key, value] of store) {
        if (opts?.prefix === undefined || key.startsWith(opts.prefix)) {
          result.set(key, value)
        }
      }
      return Promise.resolve(result)
    },
  } as unknown as DurableObjectStorage & { readonly store: Map<string, unknown> }
}

describe('EdgeSkillProvider', () => {
  it('registers as a provider and lists empty catalog', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(EdgeSkillProvider, { storage })
    const skills = await ctx.skills.list({ cwd: '/workspace' })
    expect(skills).toEqual([])
    await ctx.fiber.dispose()
  })

  it('lists skills after putSkill writes to storage', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(EdgeSkillProvider, { storage })
    await putSkill(storage, {
      name: 'my-skill',
      description: 'A test skill',
      content: 'Do the thing.',
    })
    const skills = await ctx.skills.list({ cwd: '/workspace' })
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('my-skill')
    expect(skills[0]!.description).toBe('A test skill')
    expect(skills[0]!.invocation.modelInvocable).toBe(true)
    expect(skills[0]!.invocation.userInvocable).toBe(true)
    await ctx.fiber.dispose()
  })

  it('loads full skill definition via get', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(EdgeSkillProvider, { storage })
    await putSkill(storage, {
      name: 'deploy',
      description: 'Deploy steps',
      content: 'Step 1: build\nStep 2: push',
      whenToUse: 'When deploying',
    })
    const definition = await ctx.skills.get('deploy', { cwd: '/workspace' })
    expect(definition).toBeDefined()
    expect(definition!.name).toBe('deploy')
    expect(definition!.content).toBe('Step 1: build\nStep 2: push')
    expect(definition!.provider).toBe('edge')
    await ctx.fiber.dispose()
  })

  it('deleteSkill removes a skill from storage', async () => {
    const storage = createMockStorage()
    await putSkill(storage, {
      name: 'temp',
      description: 'Temporary',
      content: 'content',
    })
    expect(await listSkillNames(storage)).toEqual(['temp'])
    const deleted = await deleteSkill(storage, 'temp')
    expect(deleted).toBe(true)
    expect(await listSkillNames(storage)).toEqual([])
  })

  it('deleteSkill returns false for nonexistent skill', async () => {
    const storage = createMockStorage()
    const deleted = await deleteSkill(storage, 'nonexistent')
    expect(deleted).toBe(false)
  })

  it('listSkillNames returns just the names', async () => {
    const storage = createMockStorage()
    await putSkill(storage, { name: 'alpha', description: 'A', content: 'a' })
    await putSkill(storage, { name: 'beta', description: 'B', content: 'b' })
    const names = await listSkillNames(storage)
    expect(names.sort()).toEqual(['alpha', 'beta'])
  })

  it('putSkill overwrites an existing skill', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(EdgeSkillProvider, { storage })
    await putSkill(storage, { name: 'x', description: 'v1', content: 'old' })
    await putSkill(storage, { name: 'x', description: 'v2', content: 'new' })
    const skills = await ctx.skills.list({ cwd: '/workspace' })
    expect(skills).toHaveLength(1)
    expect(skills[0]!.description).toBe('v2')
    const def = await ctx.skills.get('x', { cwd: '/workspace' })
    expect(def!.content).toBe('new')
    await ctx.fiber.dispose()
  })

  it('disposes cleanly via ctx.effect', async () => {
    const ctx = new Context()
    const storage = createMockStorage()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(EdgeSkillProvider, { storage })
    await putSkill(storage, { name: 'a', description: 'A', content: 'a' })
    expect(await ctx.skills.list({ cwd: '/workspace' })).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
