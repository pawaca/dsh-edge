import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { EdgeSessionStore } from '../src/session-store.ts'

const ID = SessionId('session-1')

function store(context: object) {
  return Object.assign(Object.create(EdgeSessionStore.prototype) as object, {
    ready: Promise.resolve(),
    context,
  }) as unknown as EdgeSessionStore
}

describe('where a session is now', () => {
  it('reads the working-directory projection of a live agent', async () => {
    const session = { header: { cwd: '/workspace' } }
    const get = vi.fn(() => '/workspace/proj')
    const found = store({ agents: { get: () => ({ session }) }, workingDirectory: { get } })
    expect(await found.currentDirectory(ID, '/workspace')).toBe('/workspace/proj')
    expect(get).toHaveBeenCalledWith(session)
  })

  it('reads it cold from the stored session and releases the observation', async () => {
    const dispose = vi.fn()
    const observeSession = vi.fn(async () => ({
      projections: { values: { workingDirectory: '/workspace/proj' } },
      [Symbol.dispose]: dispose,
    }))
    const found = store({ agents: { get: () => undefined }, sessionQuery: { observeSession } })
    expect(await found.currentDirectory(ID, '/workspace')).toBe('/workspace/proj')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it.each([
    ['has never moved', { projections: { values: {} } }],
    ['has no projections', {}],
  ])('falls back to the starting directory when the session %s', async (_name, observation) => {
    const observeSession = async () => ({ ...observation, [Symbol.dispose]() {} })
    const found = store({ agents: { get: () => undefined }, sessionQuery: { observeSession } })
    expect(await found.currentDirectory(ID, '/workspace/started')).toBe('/workspace/started')
  })

  it('falls back to the starting directory when the session cannot be observed', async () => {
    const found = store({
      agents: { get: () => undefined },
      sessionQuery: { observeSession: async () => { throw new Error('not found') } },
    })
    expect(await found.currentDirectory(ID, '/workspace/started')).toBe('/workspace/started')
  })
})
