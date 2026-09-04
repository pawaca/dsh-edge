import type { Context, Disposable } from '@deepseek-ai/cordis'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'

interface EdgeSlots {
  inject(name: string, callback: () => Disposable | Generator<Disposable>): Disposable
  register(spec: object, component: unknown): Disposable
}
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { EdgeDirectoryFlow } from './EdgeDirectoryFlow.tsx'
import { EdgeSettingsSection, type EdgeSettingsInjected } from './EdgeSettingsSection.tsx'
import { EdgeSettingsController } from './store.ts'
import { en, zh, type EdgeSettingsKey } from './locales.ts'

export type { EdgeSettingsInjected, EdgeSettingsSectionProps } from './EdgeSettingsSection.tsx'
export type { EdgeSettingsKey } from './locales.ts'
export type { EdgeSettingsState, EdgeHealth } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.edge': EdgeSettingsKey }
  interface SlotMap {
    'sidebar.workspaces.directoryFlow': {
      kind: 'single'
      scope: 'root'
      owner: {
        open: boolean
        busy: boolean
        onPicked: (path: string) => void
        onCancel: () => void
        onError: (message: string) => void
      }
    }
    'conversation.hero.workspace.directoryFlow': {
      kind: 'single'
      scope: 'root'
      owner: {
        open: boolean
        busy: boolean
        onPicked: (path: string) => void
        onCancel: () => void
        onError: (message: string) => void
      }
    }
  }
}

export const inject = ['slots', 'locale', 'settingsScope', 'workspaces']

export function apply(ctx: Context): void {
  // Edge's API proxy fully supports settings RPCs over the remote transport.
  // The upstream settings mirror defaults to "memory" (no-load) for non-loopback
  // connections. Promote it to "host" so the Models page can read settings.
  const slots: EdgeSlots = (ctx as unknown as { slots: EdgeSlots }).slots
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
  slots.inject('conversation.hero.workspace.directoryFlow', () =>
    slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield slots.register(
        { name: 'conversation.hero.workspace.directoryFlow', locale: 'settings.edge' },
        EdgeDirectoryFlow,
      )
      yield slots.register(
        { name: 'sidebar.workspaces.directoryFlow', locale: 'settings.edge' },
        EdgeDirectoryFlow,
      )
    }),
  )
  const workspaces = (ctx as never as { workspaces: { openPath(path: string): Promise<void> } }).workspaces
  const originalOpenPath = workspaces.openPath.bind(workspaces)
  workspaces.openPath = async (path: string) => {
    try {
      await originalOpenPath(path)
    } catch {
      const url = `/api/workspace/file?path=${encodeURIComponent(path)}`
      const res = await globalThis.fetch(url)
      if (!res.ok) throw new Error(`path open failed: ${res.status === 413 ? 'file too large' : await res.text()}`)
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = path.split('/').pop() ?? 'file'
      a.click()
      URL.revokeObjectURL(blobUrl)
    }
  }
}
