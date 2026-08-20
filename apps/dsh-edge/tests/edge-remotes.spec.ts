import { describe, expect, it } from 'vitest'
import { handleEdgeRemote } from '../src/edge-remotes.ts'

describe('Edge generated Remote carrier', () => {
  it('serves the truthful empty upstream command catalog', async () => {
    const response = await handleEdgeRemote(new Request('https://edge.test/api/commands/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'command-list-1',
        method: 'commands/list',
        payload: { args: { agentId: 'session-1' } },
      }),
    }))

    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toEqual({
      type: 'server-response',
      rpcId: 'command-list-1',
      result: { ok: true, value: [] },
    })
  })

  it('leaves unowned ApiProxy paths to the upstream HTTP carrier', async () => {
    await expect(handleEdgeRemote(new Request('https://edge.test/api/session.list')))
      .resolves.toBeUndefined()
  })
})
