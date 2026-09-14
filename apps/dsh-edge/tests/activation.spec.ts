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
      new Response(null, { status: 303, headers: { 'set-cookie': '__Host-dsh_edge_owner=v1.9999999999.signature; Secure; HttpOnly' } }),
      Response.json({ ...READY_HEALTH, runtime: true }),
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
      publicUrl: 'https://dsh-edge.preview.workers.dev/',
      mode: 'direct',
      ownerSecret: 'activation-owner-access-key-32-bytes',
      fetchImpl,
      now: () => time,
      retryMs: 1_000,
      sleepImpl,
      waitMs: 5_000,
    })).resolves.toEqual({ attempts: 3, elapsedMs: 2_000, status: 'ready' })

    expect(requests).toHaveLength(5)
    expect(requests[0]?.input).toBe('https://dsh-edge.preview.workers.dev/api/health')
    expect(requests[0]?.init).toMatchObject({ redirect: 'manual' })
    const headers = new Headers(requests[0]?.init?.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('cache-control')).toBe('no-cache')
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
    expect(requests[3]?.input).toBe('https://dsh-edge.preview.workers.dev/api/auth/login')
    expect(new Headers(requests[3]?.init?.headers).get('origin')).toBe('https://dsh-edge.preview.workers.dev')
    expect(requests[4]?.input).toBe('https://dsh-edge.preview.workers.dev/api/ready')
    expect(new Headers(requests[4]?.init?.headers).get('cookie')).toBe('__Host-dsh_edge_owner=v1.9999999999.signature')
    expect(requests[4]?.init?.body).toBeUndefined()
  })

  it.each([false, true])('retries a previous deployment key rejection (eventuallyReady=%s)', async eventuallyReady => {
    let time = 0
    let logins = 0
    const ownerSecret = '密'.repeat(16) // 48 UTF-8 bytes, 16 UTF-16 code units.
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/api/health')) return Response.json(READY_HEALTH)
      if (url.endsWith('/api/auth/login')) {
        expect(new URLSearchParams(init?.body as string).get('accessKey')).toBe(ownerSecret)
        if (++logins === 1 || !eventuallyReady) return new Response(null, { status: 401 })
        return new Response(null, { status: 303, headers: { 'set-cookie': '__Host-dsh_edge_owner=v1.9999999999.signature; Secure' } })
      }
      return Response.json({ ...READY_HEALTH, runtime: true })
    }) as typeof fetch
    const result = await observePublicActivation({
      publicUrl: 'https://dsh-edge.owner.workers.dev/', mode: 'direct', ownerSecret, fetchImpl,
      now: () => time, waitMs: 3, retryMs: 1, sleepImpl: async () => { time++ },
    })
    expect(result.status).toBe(eventuallyReady ? 'ready' : 'pending')
    expect(logins).toBe(eventuallyReady ? 2 : 3)
  })

  it('does not report ready when the release responds but the runtime failed', async () => {
    const responses = [Response.json(READY_HEALTH),
      new Response(null, { status: 303, headers: { 'set-cookie': '__Host-dsh_edge_owner=v1.9999999999.signature; Secure' } }),
      Response.json({ code: 'runtime-initialization-failed' }, { status: 503 })]
    const fetchImpl = vi.fn(async () => responses.shift()!) as typeof fetch
    await expect(observePublicActivation({ publicUrl: 'https://dsh-edge.owner.workers.dev/', mode: 'direct',
      ownerSecret: 'activation-owner-access-key-32-bytes', fetchImpl,
    })).rejects.toThrow('Upgrade is not ready')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('never follows login redirects or sends a cookie to a different origin', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/api/health')
      ? Response.json(READY_HEALTH)
      : new Response(null, { status: 302, headers: { location: 'https://other.example/' } })) as typeof fetch
    let time = 0
    const result = await observePublicActivation({ publicUrl: 'https://dsh-edge.owner.workers.dev', mode: 'direct',
      ownerSecret: 'activation-owner-access-key-32-bytes', fetchImpl, now: () => time,
      waitMs: 1, retryMs: 1, sleepImpl: async () => { time++ },
    })
    expect(result.status).toBe('pending')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const [url, init] of vi.mocked(fetchImpl).mock.calls) {
      expect((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)).toMatch(/^https:\/\/dsh-edge.owner.workers.dev\/api\//u)
      expect(init?.redirect).toBe('manual')
    }
  })

  it('keeps an upload successful when activation remains pending', async () => {
    const fetchImpl = vi.fn(async () => new Response('Not found', { status: 404 })) as typeof fetch
    let time = 0

    await expect(observePublicActivation({
      publicUrl: 'https://dsh-edge.owner.workers.dev',
      mode: 'direct',
      ownerSecret: 'activation-owner-access-key-32-bytes',
      fetchImpl,
      now: () => time,
      retryMs: 1_000,
      sleepImpl: async (delay) => { time += delay },
      waitMs: 2_500,
    })).resolves.toEqual({ attempts: 3, elapsedMs: 2_500, status: 'pending' })
  })

  it('caps the final request timeout at the remaining activation budget', async () => {
    let time = 0
    const requestTimeouts: number[] = []
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      requestTimeouts.push(delay)
      time += delay
      return new AbortController().signal
    })
    try {
      await expect(observePublicActivation({
        publicUrl: 'https://dsh-edge.owner.workers.dev',
        mode: 'direct',
      ownerSecret: 'activation-owner-access-key-32-bytes',
        fetchImpl: vi.fn(async () => new Response('Not found', { status: 404 })) as typeof fetch,
        now: () => time,
        requestTimeoutMs: 4_000,
        retryMs: 1_500,
        sleepImpl: async (delay) => { time += delay },
        waitMs: 45_000,
      })).resolves.toEqual({ attempts: 9, elapsedMs: 45_000, status: 'pending' })

      expect(requestTimeouts).toEqual([
        4_000,
        4_000,
        4_000,
        4_000,
        4_000,
        4_000,
        4_000,
        4_000,
        1_000,
      ])
    } finally {
      timeout.mockRestore()
    }
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
      ownerSecret: 'activation-owner-access-key-32-bytes',
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
      ownerSecret: 'activation-owner-access-key-32-bytes',
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
      ownerSecret: 'activation-owner-access-key-32-bytes',
      waitMs: 0,
    })).rejects.toThrow('public workers.dev origin')
  })
})
