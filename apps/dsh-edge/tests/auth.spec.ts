import { describe, expect, it, vi } from 'vitest'
import {
  handleOwnerAuthRoute,
  isOwnerAuthenticated,
  resolveOwnerAuthConfig,
  resolveOwnerSession,
  unauthorizedResponse,
} from '../src/auth.ts'
import { errorResponse, resolveDeepSeekApiKey } from '../src/http.ts'

const ACCESS_KEY = 'owner-test-access-key-32-bytes-long'
const config = resolveOwnerAuthConfig(ACCESS_KEY)

describe('single-owner authentication', () => {
  it('fails closed for missing, short, or padded deployment keys', () => {
    expect(() => resolveOwnerAuthConfig(undefined)).toThrow(/not configured safely/u)
    expect(() => resolveOwnerAuthConfig('short')).toThrow(/not configured safely/u)
    expect(() => resolveOwnerAuthConfig(` ${ACCESS_KEY}`)).toThrow(/not configured safely/u)
  })

  it('accepts keys whose UTF-8 encoding meets the byte minimum', async () => {
    const unicodeKey = '🔐'.repeat(8)
    const unicodeConfig = resolveOwnerAuthConfig(unicodeKey)
    const response = await handleOwnerAuthRoute(new Request('https://edge.example/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://edge.example',
      },
      body: new URLSearchParams({ accessKey: unicodeKey }),
    }), unicodeConfig)
    expect(response?.status).toBe(303)
  })

  it('renders a script-free login form with defensive browser headers', async () => {
    const response = await route(new Request('https://edge.example/login'))
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('Owner access key')
    expect(body).not.toContain('minlength=')
    expect(body).not.toContain('maxlength=')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('rejects invalid keys without setting a cookie', async () => {
    const response = await login('not-the-right-access-key-at-all')
    expect(response.status).toBe(401)
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(await response.text()).toContain('The access key is not valid.')
  })

  it('sets a secure signed cookie and accepts it until it expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'))
    try {
      const response = await login(ACCESS_KEY)
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/')
      const setCookie = response.headers.get('set-cookie')
      expect(setCookie).toContain('__Host-dsh_edge_owner=v1.')
      expect(setCookie).toContain('; HttpOnly;')
      expect(setCookie).toContain('; SameSite=Strict;')
      expect(setCookie).toContain('; Secure')

      const cookie = setCookie?.split(';', 1)[0]
      expect(cookie).toBeDefined()
      const request = new Request('https://edge.example/api/sessions', {
        headers: { cookie: cookie! },
      })
      await expect(isOwnerAuthenticated(request, config)).resolves.toBe(true)
      await expect(resolveOwnerSession(request, config)).resolves.toEqual({
        expiresAt: Number(cookie!.split('.')[1]),
      })

      vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1_000 + 1_000)
      await expect(isOwnerAuthenticated(request, config)).resolves.toBe(false)
      await expect(resolveOwnerSession(request, config)).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a host-bound cookie on HTTPS and accepts a valid duplicate after an invalid one', async () => {
    const response = await login(ACCESS_KEY)
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0]!
    expect(response.headers.get('set-cookie')).toContain('; Secure')
    await expect(isOwnerAuthenticated(new Request('https://edge.example/', {
      headers: { cookie: `__Host-dsh_edge_owner=invalid; ${cookie}` },
    }), config)).resolves.toBe(true)

    const localResponse = await route(new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://localhost',
      },
      body: new URLSearchParams({ accessKey: ACCESS_KEY }),
    }))
    expect(localResponse.headers.get('set-cookie')).toContain('dsh_edge_owner=v1.')
    expect(localResponse.headers.get('set-cookie')).not.toContain('; Secure')
  })

  it('rejects a tampered signature and a cookie signed by a rotated key', async () => {
    const response = await login(ACCESS_KEY)
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0]!
    const signatureStart = cookie.lastIndexOf('.') + 1
    const tampered = [
      cookie.slice(0, signatureStart),
      cookie[signatureStart] === 'a' ? 'b' : 'a',
      cookie.slice(signatureStart + 1),
    ].join('')
    await expect(isOwnerAuthenticated(new Request('https://edge.example/', {
      headers: { cookie: tampered },
    }), config)).resolves.toBe(false)
    await expect(isOwnerAuthenticated(new Request('https://edge.example/', {
      headers: { cookie },
    }), resolveOwnerAuthConfig('rotated-owner-access-key-32-bytes'))).resolves.toBe(false)
  })

  it('rejects cross-origin login and oversized login bodies', async () => {
    await expect(route(new Request('https://edge.example/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://attacker.example',
      },
      body: `accessKey=${ACCESS_KEY}`,
    }))).rejects.toMatchObject({ status: 403 })

    await expect(route(new Request('https://edge.example/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `accessKey=${'x'.repeat(5_000)}`,
    }))).rejects.toMatchObject({ status: 413 })
  })

  it('reports session state and clears the cookie on logout', async () => {
    const loginResponse = await login(ACCESS_KEY)
    const cookie = loginResponse.headers.get('set-cookie')!.split(';', 1)[0]!
    const session = await route(new Request('https://edge.example/api/auth/session', {
      headers: { cookie },
    }))
    expect(await session.json()).toEqual({ authenticated: true })

    const logout = await route(new Request('https://edge.example/api/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://edge.example' },
    }))
    expect(logout.status).toBe(303)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('challenges only owner-authentication 401 responses', () => {
    const ownerAuth = unauthorizedResponse()
    expect(ownerAuth.status).toBe(401)
    expect(ownerAuth.headers.get('www-authenticate')).toBe('DshEdgeOwner')

    let missingProviderKey: unknown
    try {
      resolveDeepSeekApiKey()
    } catch (error) {
      missingProviderKey = error
    }
    const providerAuth = errorResponse(missingProviderKey)
    expect(providerAuth.status).toBe(401)
    expect(providerAuth.headers.get('www-authenticate')).toBeNull()
  })
})

async function login(accessKey: string): Promise<Response> {
  return route(new Request('https://edge.example/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://edge.example',
    },
    body: new URLSearchParams({ accessKey }),
  }))
}

async function route(request: Request): Promise<Response> {
  const response = await handleOwnerAuthRoute(request, config)
  if (response === undefined) throw new Error('Expected an authentication route response.')
  return response
}
