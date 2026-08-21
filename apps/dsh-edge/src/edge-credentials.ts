/** Read-only upstream credential provider over Cloudflare Worker secrets. */

import type { Context } from '@deepseek-ai/cordis'
import CredentialProvider, {
  credentialRef,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

export const EDGE_DEEPSEEK_API_KEY_REF = credentialRef('DEEPSEEK_API_KEY')

export interface EdgeCredentialProviderConfig {
  /** Read the current deployment secret without copying it into Durable Object storage. */
  readDeepSeekApiKey(): string | undefined
}

/** Resolve deployment credentials through the same seam used by upstream providers. */
export class EdgeCredentialProvider extends CredentialProvider {
  constructor(
    ctx: Context,
    private readonly config: EdgeCredentialProviderConfig,
  ) {
    super(ctx)
  }

  /** Resolve the supported Worker secret for one operation. */
  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (ref !== EDGE_DEEPSEEK_API_KEY_REF) return Promise.resolve(undefined)
    const value = this.config.readDeepSeekApiKey()?.trim()
    if (value === undefined || value.length === 0) return Promise.resolve(undefined)
    return Promise.resolve({ value, source: 'worker-secret' })
  }

  /** Describe a Worker secret without exposing its value. */
  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const resolved = await this.resolve(ref)
    return {
      configured: resolved !== undefined,
      ...resolved === undefined ? {} : { source: resolved.source },
      writable: false,
    }
  }

  /** Cloudflare secrets are changed through deployment tooling, not runtime RPCs. */
  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.reject(new Error('dsh-edge credentials are read-only; update the Cloudflare Worker secret.'))
  }

  /** Cloudflare secrets are changed through deployment tooling, not runtime RPCs. */
  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.reject(new Error('dsh-edge credentials are read-only; update the Cloudflare Worker secret.'))
  }

  /** Edge currently exposes deployment-secret references, not provider-owned authorization records. */
  override readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  /** Report the unsupported record space without exposing or inventing storage. */
  override describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }

  /** No provider-owned authorization records exist in this deployment. */
  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  /** Record creation and token refresh require a dedicated Edge record store. */
  override modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return Promise.reject(new Error(
      'dsh-edge credential records are unavailable; this deployment supports Worker-secret references only.',
    ))
  }

  /** Deleting an absent record is the required no-op. */
  override deleteRecord(_key: CredentialKey): Promise<void> {
    return Promise.resolve()
  }
}

export default EdgeCredentialProvider
