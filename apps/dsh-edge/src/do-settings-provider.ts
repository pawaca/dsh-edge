/** Durable Object storage provider for the upstream user-settings seam. */

import type { Context } from '@deepseek-ai/cordis'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

const SETTINGS_DOCUMENT_KEY = 'dsh-edge:settings-document'

export interface DurableObjectSettingsProviderConfig {
  storage: DurableObjectStorage
}

/**
 * Persist settings sections in the owning Durable Object's KV storage.
 * Each namespace is a key in the stored document; load/persist use the
 * same key so the entire document survives hibernation.
 */
export class DurableObjectSettingsProvider extends SettingsProvider {
  private readonly storage: DurableObjectStorage

  override readonly writable = true

  constructor(ctx: Context, config: DurableObjectSettingsProviderConfig) {
    super(ctx)
    this.storage = config.storage
  }

  protected override async load(): Promise<Record<string, unknown>> {
    const stored = await this.storage.get(SETTINGS_DOCUMENT_KEY)
    if (stored === undefined || stored === null) return {}
    if (typeof stored !== 'object' || Array.isArray(stored)) return {}
    return stored as Record<string, unknown>
  }

  protected override async persist(
    ns: SettingsNamespace,
    section: Record<string, unknown>,
  ): Promise<void> {
    const doc = await this.load()
    doc[ns as string] = section
    await this.storage.put(SETTINGS_DOCUMENT_KEY, doc)
  }
}

export default DurableObjectSettingsProvider
