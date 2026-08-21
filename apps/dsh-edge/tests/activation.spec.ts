import { describe, expect, it, vi } from 'vitest'
import edgePackage from '../package.json'
import {
  isExpectedHealth,
  observePublicActivation,
} from '../scripts/activation.mjs'

const READY_HEALTH = {
  ok: true,
  service: 'dsh-edge',
  status: 'ready',
  storage: 'durable-object-sqlite-vfs',
  shell: 'just-bash-direct',
  deploymentId: `dsh-edge@${edgePackage.version}/direct`,
  version: edgePackage.version,
}

describe('public deployment activation', () => {
  it('waits through platform and placeholder responses for the exact release', async () => {
    const responses = [
      new Response('Forbidden', { status: 403 }),
      new Response('<h1>There is nothing here yet</h1>', {
        headers: { 'content-type': 'text/html' },
      }),
      Response.json(READY_HEALTH),
    ]
    const requests: Array<{ input: string; init: RequestInit | undefined }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input.url
      requests.push({ input: url, init })
      const response = responses.shift()
      if (response === undefined) throw new Error('Unexpected activation request.')
      return response
    }) as typeof fetch
    let time = 0
    const sleepImpl = vi.fn(async (delay: number) => {
      time += delay
    })

    await expect(observePublicActivation({
      publicUrl: 'https://dsh-edge.preview.workers.dev',
      mode: 'direct',
      fetchImpl,
      now: () => time,
      retryMs: 1_000,
      sleepImpl,
      waitMs: 5_000,
    })).resolves.toEqual({ attempts: 3, elapsedMs: 2_000, status: 'ready' })

    expect(requests).toHaveLength(3)
    expect(requests[0]?.input).toBe('https://dsh-edge.preview.workers.dev/api/health')
    expect(requests[0]?.init).toMatchObject({ redirect: 'manual' })
    const headers = new Headers(requests[0]?.init?.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('cache-control')).toBe('no-cache')
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
  })

  it('keeps an upload successful when activation remains pending', async () => {
    const fetchImpl = vi.fn(async () => new Response('Not found', { status: 404 })) as typeof fetch
    let time = 0

    await expect(observePublicActivation({
      publicUrl: 'https://dsh-edge.owner.workers.dev',
      mode: 'direct',
      fetchImpl,
      now: () => time,
      retryMs: 1_000,
      sleepImpl: async (delay) => { time += delay },
      waitMs: 2_500,
    })).resolves.toEqual({ attempts: 3, elapsedMs: 2_500, status: 'pending' })
  })

  it('does not accept another release, runtime, or oversized response', async () => {
    const oversized = JSON.stringify({ ...READY_HEALTH, padding: 'x'.repeat(70 * 1024) })
    const responses = [
      Response.json({ ...READY_HEALTH, deploymentId: 'dsh-edge@0.1.3/direct' }),
      Response.json({ ...READY_HEALTH, shell: 'just-bash-isolated' }),
      new Response(oversized, { headers: { 'content-type': 'application/json' } }),
    ]
    const fetchImpl = vi.fn(async () => responses.shift() ?? new Response('', { status: 404 })) as typeof fetch
    let time = 0

    await expect(observePublicActivation({
      publicUrl: 'https://dsh-edge.owner.workers.dev',
      mode: 'direct',
      fetchImpl,
      now: () => time,
      retryMs: 1,
      sleepImpl: async (delay) => { time += delay },
      waitMs: 3,
    })).resolves.toMatchObject({ attempts: 3, status: 'pending' })
  })

  it('propagates an owner interruption instead of disguising it as pending', async () => {
    const controller = new AbortController()
    const interrupted = new Error('interrupted')
    controller.abort(interrupted)

    await expect(observePublicActivation({
      publicUrl: 'https://dsh-edge.owner.workers.dev',
      mode: 'direct',
      signal: controller.signal,
    })).rejects.toBe(interrupted)
  })

  it('accepts only the complete public health identity and a workers.dev origin', async () => {
    expect(isExpectedHealth(READY_HEALTH, {
      deploymentId: `dsh-edge@${edgePackage.version}/direct`,
      shell: 'just-bash-direct',
    })).toBe(true)
    expect(isExpectedHealth({ ...READY_HEALTH, status: 'starting' }, {
      deploymentId: `dsh-edge@${edgePackage.version}/direct`,
      shell: 'just-bash-direct',
    })).toBe(false)

    await expect(observePublicActivation({
      publicUrl: 'https://example.com',
      mode: 'direct',
      waitMs: 0,
    })).rejects.toThrow('public workers.dev origin')
  })
})
