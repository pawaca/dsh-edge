import { afterEach, expect, it, vi } from 'vitest'

const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
  vi.resetModules()
})

async function install(respond: (init: RequestInit | undefined) => Response) {
  const platform = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => respond(init))
  globalThis.fetch = platform as typeof fetch
  await import('../src/fetch-redirect-error.ts')
  return platform
}

it('requests redirect "error" as manual and fails on a redirect like the Fetch standard', async () => {
  const platform = await install(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }))
  await expect(fetch('https://api.test/v1/messages', { method: 'POST', redirect: 'error' })).rejects.toThrow(TypeError)
  expect(platform.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'manual' })
})

it('returns non-redirect responses and leaves other redirect modes to the platform', async () => {
  const platform = await install(() => new Response('ok', { status: 200 }))
  expect(await (await fetch('https://api.test/', { redirect: 'error' })).text()).toBe('ok')
  await fetch('https://api.test/', { redirect: 'follow' })
  expect(platform.mock.calls[1]![1]).toEqual({ redirect: 'follow' })
})
