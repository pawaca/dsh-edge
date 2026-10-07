import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { EdgeSettingsKey } from './locales.ts'
import css from './EdgeSettingsSection.module.css'

/** One configuration card an upstream settings package registered into `plugins.item`. */
export interface PluginSettingsItem {
  id: string
  label: string
}

export interface EdgePluginSettingsInjected {
  hooks: { pluginSettingsItems: ObservableSnapshot<readonly PluginSettingsItem[]> }
}

/**
 * Upstream renders the `plugins.item` cards on its plugin manager page, which
 * installs and removes plugins through a runtime Loader the Edge does not
 * have. This tab hosts the same slot inside Built-in plugins and renders each
 * card the way that page does: its one-line summary, then its settings form.
 */
export interface EdgePluginSettingsTabProps {
  t: (key: EdgeSettingsKey) => string
  renderSlot: (name: 'plugins.item', props: { view: 'summary' | 'page' }, options: { only: string }) => ReactNode
  usePluginSettingsItems: <T>(select: (items: readonly PluginSettingsItem[]) => T) => T
}

export function EdgePluginSettingsTab({ t, renderSlot, usePluginSettingsItems }: EdgePluginSettingsTabProps): ReactNode {
  const items = usePluginSettingsItems(value => value)
  if (items.length === 0) return <p className={css.pluginSettingsEmpty}>{t('pluginSettingsEmpty')}</p>
  return (
    <div className={css.pluginSettings}>
      {items.map(item => (
        <section key={item.id} className={css.card} data-plugin-item={item.id}>
          <h3>{item.label}</h3>
          <p>{renderSlot('plugins.item', { view: 'summary' }, { only: item.id })}</p>
          {renderSlot('plugins.item', { view: 'page' }, { only: item.id })}
        </section>
      ))}
    </div>
  )
}
