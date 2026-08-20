import { describe, expect, it, vi } from 'vitest'
import { EdgeSettingsController } from '../src/client/store.ts'

const HEALTH = {
  ok: true as const,
  service: 'dsh-edge' as const,
  storage: 'durable-object-sqlite-vfs' as const,
  shell: 'just-bash-direct' as const,
  deploymentId: 'deploy-test',
  version: '1.2.3',
  upstreamVersion: '0.1.0-rc.7',
  status: 'ready' as const,
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Edge settings controller', () => {
  it('loads authenticated deployment health lazily', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(HEALTH)).mockResolvedValueOnce(response({ version: '1.2.3' }))
    const controller = new EdgeSettingsController({ fetch, copy: vi.fn(), navigate: vi.fn() })
    expect(controller.store.getSnapshot().status).toBe('idle')
    await controller.load()
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/health', { credentials: 'same-origin' })
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', health: HEALTH,
    })
  })

  it('signs out through the same-origin route', async () => {
    const navigate = vi.fn()
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
    const controller = new EdgeSettingsController({ fetch, copy: vi.fn(), navigate })
    await controller.signOut()
    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', {
      method: 'POST', credentials: 'same-origin', redirect: 'manual',
    })
    expect(navigate).toHaveBeenCalledWith('/login')
  })

  it('contains invalid health and logout failures', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockRejectedValueOnce(new Error('logout offline'))
    const controller = new EdgeSettingsController({ fetch, copy: vi.fn(), navigate: vi.fn() })
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'Invalid Edge health response' })
    await controller.signOut()
    expect(controller.store.getSnapshot()).toMatchObject({ signingOut: false, signOutError: 'logout offline' })
  })

  it('ignores stale loads', async () => {
    const first = Promise.withResolvers<Response>()
    const fetch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(response({ ...HEALTH, deploymentId: 'fresh' }))
    const controller = new EdgeSettingsController({
      fetch,
      copy: vi.fn(),
      navigate: vi.fn(),
    })
    const stale = controller.load()
    await controller.load()
    first.resolve(response({ ...HEALTH, deploymentId: 'stale' }))
    await stale
    expect(controller.store.getSnapshot().health?.deploymentId).toBe('fresh')
  })

  it('keeps health loading and owner-session state independent', async () => {
    const firstHealth = Promise.withResolvers<Response>()
    const secondHealth = Promise.withResolvers<Response>()
    const logout = Promise.withResolvers<Response>()
    let healthCalls = 0
    const fetch = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/auth/logout' && init?.method === 'POST') return logout.promise
      if (input.startsWith('https://registry.npmjs.org/')) return Promise.resolve(response({ version: '1.2.3' }))
      healthCalls += 1
      return healthCalls === 1 ? firstHealth.promise : secondHealth.promise
    })
    const controller = new EdgeSettingsController({ fetch, copy: vi.fn(), navigate: vi.fn() })

    const loading = controller.load()
    const signingOut = controller.signOut()
    expect(controller.store.getSnapshot().signingOut).toBe(true)
    firstHealth.resolve(response(HEALTH))
    await loading
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', signingOut: true })

    logout.reject(new Error('logout offline'))
    await signingOut
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', signingOut: false, signOutError: 'logout offline',
    })

    const failedReload = controller.load()
    secondHealth.reject(new Error('health offline'))
    await failedReload
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'error', signingOut: false, signOutError: 'logout offline',
    })
  })

  it('checks npm and copies the upgrade command without changing deployment state', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    const fetch = vi.fn().mockResolvedValueOnce(response(HEALTH)).mockResolvedValueOnce(response({ version: '2.0.0' }))
    const controller = new EdgeSettingsController({ fetch, copy, navigate: vi.fn() })
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ releaseStatus: 'update-available', latestVersion: '2.0.0' })
    await controller.copyUpgrade()
    expect(copy).toHaveBeenCalledWith('npx dsh-edge@latest upgrade')
    expect(controller.store.getSnapshot()).toMatchObject({ copied: true, releaseStatus: 'update-available' })
  })
})
