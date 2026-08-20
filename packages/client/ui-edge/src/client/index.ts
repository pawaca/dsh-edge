import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { EdgeSettingsSection, type EdgeSettingsInjected } from './EdgeSettingsSection.tsx'
import { EdgeSettingsController } from './store.ts'
import { en, zh, type EdgeSettingsKey } from './locales.ts'

export type { EdgeSettingsInjected, EdgeSettingsSectionProps } from './EdgeSettingsSection.tsx'
export type { EdgeSettingsKey } from './locales.ts'
export type { EdgeSettingsState, EdgeHealth } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.edge': EdgeSettingsKey }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
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
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-edge',
    order: 90,
    label: () => ctx.locale.bind('settings.edge')('nav'),
    locale: 'settings.edge',
    inject: injected,
  }, EdgeSettingsSection))
}
