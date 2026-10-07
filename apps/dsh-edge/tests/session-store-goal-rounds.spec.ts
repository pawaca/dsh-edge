import { describe, expect, it, vi } from 'vitest'
import { EdgeSessionStore } from '../src/session-store.ts'

/** A store whose context holds one live agent with an active goal. */
function storeWithGoal(activation: 'armed' | 'disarmed', status: 'idle' | 'running' = 'idle') {
  const agent = { id: 'session-goal', status, session: {}, cancel: vi.fn() }
  const goal = { phase: 'active', activation, roundsStarted: 1, maxGoalRounds: 5 }
  const disarm = vi.fn(() => { goal.activation = 'disarmed' })
  const handlers = new Map<string, (payload: unknown) => void>()
  const store = Object.assign(Object.create(EdgeSessionStore.prototype) as object, {
    context: {
      agents: { get: (id: string) => id === agent.id ? agent : undefined },
      goals: { get: () => ({ ...goal }), disarm },
      on: (name: string, handler: (payload: unknown) => void) => { handlers.set(name, handler); return () => {} },
    },
  }) as unknown as EdgeSessionStore
  return { store, agent, disarm, handlers }
}

describe('Edge goal rounds', () => {
  it('disarms an armed goal when a turn stops between rounds, since cancelling an idle agent is a no-op', () => {
    const { store, agent, disarm } = storeWithGoal('armed')
    store.stopAgentWork(agent as never)
    expect(disarm).toHaveBeenCalledWith(agent)
  })

  it('only cancels a running agent, so the round driver records the durable pause itself', () => {
    const { store, agent, disarm } = storeWithGoal('armed', 'running')
    store.stopAgentWork(agent as never)
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(disarm).not.toHaveBeenCalled()
  })

  it('leaves a disarmed goal alone when a turn stops between rounds', () => {
    const { store, agent, disarm } = storeWithGoal('disarmed')
    store.stopAgentWork(agent as never)
    expect(disarm).not.toHaveBeenCalled()
  })

  it('disarms a goal armed while its session\'s turn has a stop requested, whichever call armed it', async () => {
    const { store, agent, disarm, handlers } = storeWithGoal('armed')
    store.disarmGoalsArmedWhileStopping(sessionId => sessionId === agent.id)
    handlers.get('goal/activation-changed')!({ sessionId: agent.id, goal: { id: 'goal-1', revision: 1, activation: 'armed' } })
    expect(disarm).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(disarm).toHaveBeenCalledWith(agent)
  })

  it('leaves a goal armed when no stop is requested', async () => {
    const { store, agent, disarm, handlers } = storeWithGoal('armed')
    store.disarmGoalsArmedWhileStopping(() => false)
    handlers.get('goal/activation-changed')!({ sessionId: agent.id, goal: { id: 'goal-1', revision: 1, activation: 'armed' } })
    await Promise.resolve()
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
