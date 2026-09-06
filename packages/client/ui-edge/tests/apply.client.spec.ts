import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, downloadWorkspaceFile, inject } from '../src/client/index.ts'
import { EdgeSettingsSection } from '../src/client/EdgeSettingsSection.tsx'

type RemoteResult = { ok: true; value: { opened: true } } | { ok: false; error: { code: string; message: string } }

/** A `remote.session` namespace shaped like the upstream generated Remote client: methods are configurable getters. */
function remoteSessionNamespace(openWorkspacePath: (request: { path: string }) => Promise<RemoteResult>) {
  const namespace = {} as { openWorkspacePath: (request: { path: string }) => Promise<RemoteResult> }
  Object.defineProperty(namespace, 'openWorkspacePath', {
    configurable: true,
    enumerable: true,
    get: () => openWorkspacePath,
  })
  return namespace
}

function fakeContext(session: object | undefined) {
  const entries: Array<{
    options: Record<string, unknown> & { inject?: () => unknown }
    component: unknown
  }> = []
  const registerLocale = vi.fn()
  const mirror = { persistence: 'memory', load: vi.fn() }
  const disposers: Array<() => void> = []
  const ctx = {
    settingsScope: { describe: () => mirror },
    get: (key: string) => key === 'remote.session' ? session : undefined,
    inject: (_deps: string[], callback: (injected: unknown) => unknown) => callback(ctx),
    effect: (callback: () => unknown) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    },
    locale: {
      register: registerLocale,
      bind: () => (key: string) => key === 'nav' ? 'DSH Edge' : key,
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => {
        const result = callback()
        if (result && typeof result === 'object' && Symbol.iterator in result) {
          for (const _ of result as Iterable<unknown>) { /* exhaust generator */ }
        }
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        entries.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, entries, registerLocale, mirror, disposers }
}

describe('ui-edge apply', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('registers the settings section and leaves the directory flow to the upstream browse picker', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
    const { ctx, entries, registerLocale, mirror } = fakeContext(undefined)
    apply(ctx as never)
    expect(mirror.persistence).toBe('host')
    expect(mirror.load).toHaveBeenCalledOnce()
    expect(registerLocale).toHaveBeenCalledOnce()

    const settingsEntry = entries.find(e => e.component === EdgeSettingsSection)
    expect(settingsEntry).toBeDefined()
    if (settingsEntry === undefined) throw new Error('Edge settings slot was not registered')
    expect(settingsEntry.options).toMatchObject({ id: 'dsh-edge', order: 90 })
    expect((settingsEntry.options.label as () => string)()).toBe('DSH Edge')
    const injected = settingsEntry.options.inject?.() as import('../src/client/EdgeSettingsSection.tsx').EdgeSettingsInjected
    expect(injected.hooks.edgeSettings.getSnapshot().status).toBe('idle')
    expect(typeof injected.load).toBe('function')
    expect(typeof injected.copyUpgrade).toBe('function')

    // The upstream browse picker face fills both `directoryFlow` holes; a second
    // occupant of a `single` hole would fail the composition loud.
    const flowNames = entries.map(e => e.options.name).filter(name => String(name).endsWith('directoryFlow'))
    expect(flowNames).toEqual([])
  })

  it('passes a settled upstream open through untouched', async () => {
    const upstream = vi.fn(async () => ({ ok: true, value: { opened: true } }) as RemoteResult)
    const session = remoteSessionNamespace(upstream)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { ctx } = fakeContext(session)
    apply(ctx as never)
    await expect(session.openWorkspacePath({ path: '/workspace/a.txt' })).resolves.toEqual({ ok: true, value: { opened: true } })
    expect(upstream).toHaveBeenCalledWith({ path: '/workspace/a.txt' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('downloads the file through /api/workspace/file when the Host refuses a native open', async () => {
    const upstream = vi.fn(async () => ({
      ok: false,
      error: { code: 'gateway/internal', message: 'path open failed: Native file open is not available on Cloudflare Workers' },
    }) as RemoteResult)
    const session = remoteSessionNamespace(upstream)
    const fetch = vi.fn(async () => new Response('hello', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const createObjectURL = vi.fn(() => 'blob:edge/probe')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { ctx } = fakeContext(session)
    apply(ctx as never)

    await expect(session.openWorkspacePath({ path: '/workspace/notes/a.txt' })).resolves.toEqual({ ok: true, value: { opened: true } })
    expect(fetch).toHaveBeenCalledWith('/api/workspace/file?path=%2Fworkspace%2Fnotes%2Fa.txt', { credentials: 'same-origin' })
    expect(click).toHaveBeenCalledOnce()
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('a.txt')
    expect(anchor.href).toBe('blob:edge/probe')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:edge/probe')
  })

  it('keeps upstream failures that are not an open refusal, and reports oversize files', async () => {
    const badRequest = { ok: false, error: { code: 'gateway/bad-request', message: 'empty path' } } as RemoteResult
    const session = remoteSessionNamespace(vi.fn(async () => badRequest))
    const fetch = vi.fn(async () => new Response('Text files are limited to 1 MiB in the Edge API.', { status: 413 }))
    vi.stubGlobal('fetch', fetch)
    const { ctx } = fakeContext(session)
    apply(ctx as never)
    await expect(session.openWorkspacePath({ path: '' })).resolves.toBe(badRequest)
    expect(fetch).not.toHaveBeenCalled()

    await expect(downloadWorkspaceFile('/workspace/big.bin')).resolves.toEqual({
      ok: false,
      error: { code: 'gateway/internal', message: 'file too large' },
    })
    await expect(downloadWorkspaceFile('.')).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('restores the upstream method when the plugin is disposed', () => {
    const upstream = vi.fn(async () => ({ ok: true, value: { opened: true } }) as RemoteResult)
    const session = remoteSessionNamespace(upstream)
    const { ctx, disposers } = fakeContext(session)
    apply(ctx as never)
    expect(session.openWorkspacePath).not.toBe(upstream)
    for (const dispose of disposers) dispose()
    expect(session.openWorkspacePath).toBe(upstream)
  })
})
