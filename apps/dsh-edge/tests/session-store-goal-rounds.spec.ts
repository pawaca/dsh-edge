import { describe, expect, it, vi } from 'vitest'
import { EdgeSessionStore } from '../src/session-store.ts'

/** A store whose context holds one live agent with an active goal. */
function storeWithGoal(activation: 'armed' | 'disarmed') {
  const agent = { id: 'session-goal', status: 'idle', session: {}, cancel: vi.fn() }
  const goal = { phase: 'active', activation, roundsStarted: 1, maxGoalRounds: 5 }
  const disarm = vi.fn(() => { goal.activation = 'disarmed' })
  const store = Object.assign(Object.create(EdgeSessionStore.prototype) as object, {
    context: {
      agents: { get: (id: string) => id === agent.id ? agent : undefined },
      goals: { get: () => ({ ...goal }), disarm },
      on: () => () => {},
    },
  }) as unknown as EdgeSessionStore
  return { store, agent, disarm }
}

describe('Edge goal rounds', () => {
  it('disarms an armed goal when a turn stops, since cancelling an idle agent between rounds is a no-op', () => {
    const { store, agent, disarm } = storeWithGoal('armed')
    store.stopAgentWork(agent as never)
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(disarm).toHaveBeenCalledWith(agent)
  })

  it('leaves a disarmed goal alone when a turn stops', () => {
    const { store, agent, disarm } = storeWithGoal('disarmed')
    store.stopAgentWork(agent as never)
    expect(agent.cancel).toHaveBeenCalled()
    expect(disarm).not.toHaveBeenCalled()
  })

  it('disarms the goal before ending the turn when its round does not start in time', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store, agent, disarm } = storeWithGoal('armed')
      const started = (store as unknown as { goalRoundStarted: (agent: unknown) => Promise<boolean> }).goalRoundStarted(agent)
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(started).resolves.toBe(false)
      expect(disarm).toHaveBeenCalledWith(agent)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})
