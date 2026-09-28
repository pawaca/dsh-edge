import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import EdgeModelSelectionBridge from '../src/model-selection-bridge.ts'
import { EdgeAgentDefaultModel } from '../src/session-store.ts'

class TestStorage {
  readonly records = new Map<string, unknown>()

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.records.get(key))
  }

  put(key: string, value: unknown): Promise<void> {
    this.records.set(key, value)
    return Promise.resolve()
  }

  transaction<T>(closure: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> {
    const transaction = {
      get: (key: string) => Promise.resolve(this.records.get(key)),
      delete: (key: string) => Promise.resolve(this.records.delete(key)),
    }
    return closure(transaction as never)
  }
}

const id = SessionId('model-selection-bridge')
const vision: ModelSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash-vision-exp',
  reasoningEffort: ReasoningEffortId('high'),
}

describe('EdgeModelSelectionBridge', () => {
  it('restores an accepted pre-turn choice after process loss', async () => {
    const storage = new TestStorage()
    const first = new EdgeModelSelectionBridge(storage as never)
    await first.save(id, vision)

    const restarted = new EdgeModelSelectionBridge(storage as never)
    await expect(restarted.load(id)).resolves.toEqual(vision)
    expect(restarted.current(id)).toEqual(vision)
  })

  it('removes the bridge after the same choice reaches the canonical log', async () => {
    const storage = new TestStorage()
    const bridge = new EdgeModelSelectionBridge(storage as never)
    await bridge.save(id, vision)

    await expect(bridge.clearIfLogged(id, vision)).resolves.toBe(true)
    expect(storage.records.size).toBe(0)
    expect(bridge.current(id)).toBeUndefined()
    await expect(new EdgeModelSelectionBridge(storage as never).load(id)).resolves.toBeUndefined()
  })

  it('does not let an older logged request clear a newer pending choice', async () => {
    const storage = new TestStorage()
    const bridge = new EdgeModelSelectionBridge(storage as never)
    await bridge.save(id, vision)

    await expect(bridge.clearIfLogged(id, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: ReasoningEffortId('high'),
    })).resolves.toBe(false)
    expect(storage.records.size).toBe(1)
    expect(bridge.current(id)).toEqual(vision)
  })
})

describe('EdgeAgentDefaultModel', () => {
  const flash: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

  async function defaultModel(storage: TestStorage): Promise<EdgeAgentDefaultModel> {
    const ctx = new Context()
    await ctx.plugin(EdgeAgentDefaultModel, { storage: storage as never, selection: flash })
    return ctx.get('agentDefaultModel') as EdgeAgentDefaultModel
  }

  it('makes a durable pick the default for new sessions', async () => {
    const storage = new TestStorage()
    const service = await defaultModel(storage)
    await service.saveSelection(vision)
    expect(service.currentSelection()).toEqual(vision)
    expect(storage.records.get('dsh-edge:agent-default-model')).toEqual(vision)
  })

  it('keeps the prior default when the write fails', async () => {
    const storage = new TestStorage()
    storage.put = () => Promise.reject(new Error('storage unavailable'))
    const service = await defaultModel(storage)
    await expect(service.saveSelection(vision)).rejects.toThrow('storage unavailable')
    expect(service.currentSelection()).toEqual(flash)
  })
})
