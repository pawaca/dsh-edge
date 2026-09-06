import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import {
  OWNER_HOST_DECLARATION,
  WEB_SHELL_HEAD_SCRIPT,
  injectOwnerSessionGuard,
} from '../standalone/scripts/web-shell-head.mjs'

interface ShellSandbox {
  window: ShellSandbox
  location: { hostname: string; href: string; origin: string; replace: (url: string) => void }
  fetch: (...args: unknown[]) => Promise<unknown>
  __DSH_TRANSPORT__?: Record<string, unknown>
  URL: typeof URL
  Request: typeof Request
  replaced: string[]
  Response: typeof Response
  Headers: typeof Headers
}

/** Run the head script the way a browser would, on a non-loopback page. */
function runShell(options: { transport?: Record<string, unknown>; status?: number; authenticate?: string } = {}): ShellSandbox {
  const replaced: string[] = []
  const sandbox = {
    location: {
      hostname: 'example.workers.dev',
      href: 'https://example.workers.dev/',
      origin: 'https://example.workers.dev',
      replace: (url: string) => { replaced.push(url) },
    },
    fetch: async () => new Response(null, {
      status: options.status ?? 200,
      headers: options.authenticate === undefined ? {} : { 'www-authenticate': options.authenticate },
    }),
    URL,
    Request,
    Response,
    Headers,
    replaced,
    ...(options.transport === undefined ? {} : { __DSH_TRANSPORT__: options.transport }),
  } as unknown as ShellSandbox
  sandbox.window = sandbox
  runInNewContext(WEB_SHELL_HEAD_SCRIPT, sandbox)
  return sandbox
}

describe('web shell head script', () => {
  it('declares the browser transport as host-owning on a non-loopback origin', () => {
    const shell = runShell()
    expect(shell.__DSH_TRANSPORT__).toEqual({ ownsHost: true })
  })

  it('keeps a transport the embedding shell already declared', () => {
    const fetch = async () => new Response('ok')
    const shell = runShell({ transport: { fetch } })
    expect(shell.__DSH_TRANSPORT__).toEqual({ fetch, ownsHost: true })
  })

  it('still redirects owner-authentication 401 responses to /login', async () => {
    const shell = runShell({ status: 401, authenticate: 'DshEdgeOwner' })
    await shell.window.fetch('/api/session/list')
    expect(shell.replaced).toEqual(['/login'])
    await shell.window.fetch('/api/session/list')
    expect(shell.replaced).toEqual(['/login'])
  })

  it('injects the script at the top of <head> and the verifier pattern matches it', () => {
    const html = injectOwnerSessionGuard('<html><head><title>x</title></head><body></body></html>')
    expect(html.indexOf('<script>')).toBe('<html><head>'.length)
    expect(OWNER_HOST_DECLARATION.test(html)).toBe(true)
    const headless: string = injectOwnerSessionGuard('<p>no head</p>')
    expect(headless.startsWith('<script>')).toBe(true)
  })
})
