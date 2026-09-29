/**
 * Settings namespaces of the shipped Web client.
 *
 * Upstream loads each browser plugin's host half through the Loader and serves
 * its `Config` schema as a settings namespace named by the plugin's Web
 * composition entry id; the browser reads and writes that namespace (theme,
 * language, transcript view, the preview notice). The Edge assembles the Web
 * client statically and has no Loader, so it registers the same schemas under
 * the same ids.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config as ChatConfig } from '@deepseek-ai/dsh-client-ui-chat'
import { Config as ConversationConfig } from '@deepseek-ai/dsh-client-ui-conversation'
import { Config as LocaleConfig } from '@deepseek-ai/dsh-client-locale'
import { Config as ThemeConfig } from '@deepseek-ai/dsh-client-ui-theme'
import { Config as GeneralConfig } from '@deepseek-ai/dsh-client-ui-settings-general'
import { Config as SettingsConfig } from '@deepseek-ai/dsh-client-ui-settings'
import { edgeSettings } from './edge-settings.ts'

/** Shipped client packages whose host-half `Config` has live (volatile) fields, by upstream Web composition entry id. */
export const CLIENT_SETTINGS = [
  { package: '@deepseek-ai/dsh-client-ui-chat', namespace: 'ui-chat', schema: ChatConfig },
  { package: '@deepseek-ai/dsh-client-ui-conversation', namespace: 'ui-conversation', schema: ConversationConfig },
  { package: '@deepseek-ai/dsh-client-locale', namespace: 'locale', schema: LocaleConfig },
  { package: '@deepseek-ai/dsh-client-ui-theme', namespace: 'ui-theme', schema: ThemeConfig },
  { package: '@deepseek-ai/dsh-client-ui-settings-general', namespace: 'ui-settings-general', schema: GeneralConfig },
  { package: '@deepseek-ai/dsh-client-ui-settings', namespace: 'ui-settings', schema: SettingsConfig },
] as const

export function registerClientSettings(ctx: Context): void {
  const settings = edgeSettings(ctx)
  for (const { namespace, schema } of CLIENT_SETTINGS) settings.register(namespace, schema as never, {})
}
