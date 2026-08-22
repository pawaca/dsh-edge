/** Upstream credential provider over Cloudflare Worker secrets and Durable Object storage. */

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

const CREDENTIAL_STORAGE_KEY_PREFIX = 'dsh-edge:credential:'

export interface EdgeCredentialProviderConfig {
  /** Durable Object storage for runtime-writable credentials. */
  storage: DurableObjectStorage
  /** Read the current deployment secret as an immutable fallback. */
  readDeepSeekApiKey(): string | undefined
}

/** Resolve credentials from Durable Object storage with Worker environment fallback. */
export class EdgeCredentialProvider extends CredentialProvider {
  private readonly storage: DurableObjectStorage

  constructor(
    ctx: Context,
    private readonly config: EdgeCredentialProviderConfig,
  ) {
    super(ctx)
    this.storage = config.storage
  }

  /** Resolve one credential: DO storage first, then Worker env fallback for DEEPSEEK_API_KEY. */
  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const stored = await this.storage.get<string>(storageKey(ref))
    if (typeof stored === 'string' && stored.trim().length > 0) {
      return { value: stored.trim(), source: 'do-storage' }
    }
    if (ref === EDGE_DEEPSEEK_API_KEY_REF) {
      const value = this.config.readDeepSeekApiKey()?.trim()
      if (value !== undefined && value.length > 0) {
        return { value, source: 'worker-secret' }
      }
    }
    return undefined
  }

  /** Describe a credential without exposing its value. */
  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const resolved = await this.resolve(ref)
    return {
      configured: resolved !== undefined,
      ...resolved === undefined ? {} : { source: resolved.source },
      writable: true,
    }
  }

  /** Store a credential in Durable Object storage. */
  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.trim().length === 0) {
      throw new Error('Credential value must not be empty.')
    }
    await this.storage.put(storageKey(ref), value)
  }

  /** Remove a credential from Durable Object storage. */
  override async unset(ref: CredentialRef): Promise<void> {
    await this.storage.delete(storageKey(ref))
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

function storageKey(ref: CredentialRef): string {
  return CREDENTIAL_STORAGE_KEY_PREFIX + ref
}

export default EdgeCredentialProvider
