/** Read-only upstream credential provider over Cloudflare Worker secrets. */

import type { Context } from '@deepseek-ai/cordis'
import CredentialProvider, {
  credentialRef,
  type CredentialInfo,
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
}

export default EdgeCredentialProvider
