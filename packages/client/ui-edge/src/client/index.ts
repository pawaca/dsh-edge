import { installRunGuards } from './run-guards.ts'
import type { Context } from '@deepseek-ai/cordis'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { EdgeSettingsSection, type EdgeSettingsInjected } from './EdgeSettingsSection.tsx'
import { EdgeSettingsController } from './store.ts'
import { en, zh, type EdgeSettingsKey } from './locales.ts'

export type { EdgeSettingsInjected, EdgeSettingsSectionProps } from './EdgeSettingsSection.tsx'
export type { EdgeSettingsKey } from './locales.ts'
export type { EdgeSettingsState, EdgeHealth } from './store.ts'

type Slots = {
  inject(name: string, callback: (() => unknown) | (() => Generator<unknown>)): unknown
  register(spec: object, component: unknown): unknown
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.edge': EdgeSettingsKey }
}

export const inject = ['slots', 'locale', 'settingsScope']

export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: Slots }).slots
  const mirror = (ctx as never as { settingsScope: { describe(): { persistence: string; load(): void } } })
    .settingsScope.describe()
  if (mirror.persistence === 'memory') {
    mirror.persistence = 'host'
    mirror.load()
  }
  ctx.effect(() => ctx.locale.register('settings.edge', { en, zh }), 'ui-edge: settings dictionaries')
  const controller = new EdgeSettingsController({
    fetch: (input, init) => globalThis.fetch(input, init),
    copy: async (text) => {
      if (!await writeClipboard(text)) throw new Error('Clipboard write was rejected')
    },
    navigate: (path) => { globalThis.location.assign(path) },
  })
  const injected = (): EdgeSettingsInjected => ({
    hooks: { edgeSettings: controller.store },
    load: () => controller.load(),
    copyUpgrade: () => controller.copyUpgrade(),
    signOut: () => controller.signOut(),
  })
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'dsh-edge',
    order: 90,
    label: () => ctx.locale.bind('settings.edge')('nav'),
    locale: 'settings.edge',
    inject: injected,
  }, EdgeSettingsSection))
  // Upstream `dsh-client-ui-chat` opens a conversation file link through the
  // generated `ctx.remote.session.openWorkspacePath` Remote, whose Host side
  // hands the path to a native desktop opener that Cloudflare Workers cannot
  // provide. The Edge keeps the upstream call and, when the Host refuses it,
  // streams the file through the owner-authenticated `/api/workspace/file`
  // route as a browser download instead, so the chat sees a settled open.
  ctx.inject(['remote.session'], (scope) => {
    scope.effect(() => {
      const session = (scope as never as { get(key: string): object | undefined }).get('remote.session')
      return session === undefined ? () => {} : installRunGuards(session)
    }, 'ui-edge: observed run controls')
    scope.effect(() => {
      const session = (scope as never as { get(key: string): RemoteSessionNamespace | undefined }).get('remote.session')
      const descriptor = session === undefined ? undefined : Object.getOwnPropertyDescriptor(session, 'openWorkspacePath')
      const upstream = descriptor?.get?.bind(session) as (() => OpenWorkspacePath) | undefined
      if (session === undefined || descriptor === undefined || upstream === undefined) return () => {}
      Object.defineProperty(session, 'openWorkspacePath', {
        configurable: true,
        enumerable: true,
        get: () => async (request: { path: string }) => {
          const result = await upstream()(request)
          if (result.ok || result.error.code === 'gateway/bad-request') return result
          return await downloadWorkspaceFile(request.path)
        },
      })
      return () => {
        Object.defineProperty(session, 'openWorkspacePath', descriptor)
      }
    }, 'ui-edge: workspace file download fallback')
  })
}

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
type OpenWorkspacePath = (request: { path: string }) => Promise<RemoteResult<{ opened: true }>>
type RemoteSessionNamespace = { openWorkspacePath: OpenWorkspacePath }

/** Fetch one workspace file through the Edge route and hand it to the browser as a download. */
export async function downloadWorkspaceFile(path: string): Promise<RemoteResult<{ opened: true }>> {
  if (path === '.' || path.endsWith('/.') || path.endsWith('/')) {
    return { ok: false, error: { code: 'gateway/internal', message: 'Folders cannot be downloaded from the Edge workspace; open a file instead.' } }
  }
  const res = await globalThis.fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
  if (!res.ok) {
    return { ok: false, error: { code: 'gateway/internal', message: res.status === 413 ? 'file too large' : await res.text() } }
  }
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = path.split('/').pop() ?? 'file'
  try {
    anchor.click()
  } finally {
    // Firefox and Safari cancel a download whose blob URL is revoked in the
    // same task as the click; release it on a later macrotask instead.
    setTimeout(() => { URL.revokeObjectURL(blobUrl) }, 0)
  }
  return { ok: true, value: { opened: true } }
}
