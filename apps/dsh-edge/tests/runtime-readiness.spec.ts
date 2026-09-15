import { describe, expect, it } from 'vitest'
import { EdgeSessionStore } from '../src/session-store.ts'

describe('runtime model readiness', () => {
  it.each([{ providers: [] }, { providers: [{ id: 'another-provider' }] }])('rejects missing DeepSeek despite ready controllers (%j)', async ({ providers }) => {
    const store = { ready: Promise.resolve(), context: {
      get: () => ({}), llm: { listProviders: () => providers },
    } }
    // Ordinary request gating succeeds; only the installer readiness check fails.
    await expect(EdgeSessionStore.prototype.waitForInitialization.call(store as never)).resolves.toBeUndefined()
    await expect(EdgeSessionStore.prototype.assertReady.call(store as never)).rejects.toThrow('Required model adapter is unavailable')
  })

  it('still rejects ordinary requests when session initialization itself failed', async () => {
    const store = { ready: Promise.reject(new Error('session migration failed')) }
    await expect(EdgeSessionStore.prototype.waitForInitialization.call(store as never)).rejects.toThrow('session migration failed')
  })

  it('accepts a registered DeepSeek adapter without contacting the provider', async () => {
    const store = { ready: Promise.resolve(), context: {
      get: () => ({}), llm: { listProviders: () => [{ id: 'deepseek-official' }] },
    } }
    await expect(EdgeSessionStore.prototype.assertReady.call(store as never)).resolves.toBeUndefined()
  })
})
