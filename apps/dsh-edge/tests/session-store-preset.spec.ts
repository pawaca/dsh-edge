import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { EdgeSessionStore } from '../src/session-store.ts'

describe('Edge agent preset selection', () => {
  it('reports a committed selection even when releasing the old agent fails', async () => {
    const append = vi.fn()
    const flush = vi.fn(async () => {})
    const disposeResidentAgent = vi.fn(async () => { throw new Error('injected teardown failure') })
    const store = Object.assign(Object.create(EdgeSessionStore.prototype) as object, {
      context: {
        get: () => ({ offers: () => true }),
        sessions: { flush },
      },
      getOrResumeAgent: vi.fn(async () => ({
        agent: { session: { header: { agentPreset: 'dsh-edge' }, snapshotEvents: () => [], append } },
      })),
      disposeResidentAgent,
    }) as unknown as EdgeSessionStore
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(store.selectAgentPreset(SessionId('session-blank'), 'ptc', 'deepseek-v4-pro')).resolves.toBe('ptc')
      expect(append).toHaveBeenCalledWith('agent-preset/selected', { agentPreset: 'ptc' })
      expect(flush.mock.invocationCallOrder[0]).toBeLessThan(disposeResidentAgent.mock.invocationCallOrder[0]!)
      expect(log).toHaveBeenCalledWith(
        'dsh-edge failed to release the agent after a preset selection.',
        expect.objectContaining({ message: 'injected teardown failure' }),
      )
    } finally { log.mockRestore() }
  })
})
