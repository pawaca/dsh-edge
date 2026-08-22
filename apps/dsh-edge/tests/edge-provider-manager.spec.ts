import { describe, expect, it } from 'vitest'
import {
  readConfiguredProviders,
  writeConfiguredProviders,
  type EdgeProviderEntry,
} from '../src/edge-provider-manager.ts'

function createMockStorage(): DurableObjectStorage & { readonly store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
    delete: (key: string) => { store.delete(key); return Promise.resolve(true) },
  } as unknown as DurableObjectStorage & { readonly store: Map<string, unknown> }
}

const validProvider: EdgeProviderEntry = {
  id: 'openai',
  name: 'OpenAI',
  baseURL: 'https://api.openai.com/v1',
  apiKeyRef: 'OPENAI_API_KEY',
  models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
}

describe('EdgeProviderManager storage', () => {
  it('reads empty array from fresh storage', async () => {
    const storage = createMockStorage()
    expect(await readConfiguredProviders(storage)).toEqual([])
  })

  it('round-trips a provider entry', async () => {
    const storage = createMockStorage()
    await writeConfiguredProviders(storage, [validProvider])
    const result = await readConfiguredProviders(storage)
    expect(result).toEqual([validProvider])
  })

  it('filters invalid entries on read', async () => {
    const storage = createMockStorage()
    storage.store.set('dsh-edge:configured-providers', [
      validProvider,
      { id: '', name: 'bad', baseURL: '', apiKeyRef: '', models: [] },
      'not-an-object',
      null,
    ])
    const result = await readConfiguredProviders(storage)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('openai')
  })

  it('returns empty for non-array stored data', async () => {
    const storage = createMockStorage()
    storage.store.set('dsh-edge:configured-providers', 'not-an-array')
    expect(await readConfiguredProviders(storage)).toEqual([])
  })

  it('preserves multiple providers', async () => {
    const storage = createMockStorage()
    const anthropic: EdgeProviderEntry = {
      id: 'anthropic',
      name: 'Anthropic',
      baseURL: 'https://api.anthropic.com',
      apiKeyRef: 'ANTHROPIC_API_KEY',
      models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
    }
    await writeConfiguredProviders(storage, [validProvider, anthropic])
    const result = await readConfiguredProviders(storage)
    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe('openai')
    expect(result[1]!.id).toBe('anthropic')
  })
})
