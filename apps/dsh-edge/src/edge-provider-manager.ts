/** Dynamic LLM provider registration from Durable Object storage. */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LlmError,
  assertUsableApiKey,
} from '@deepseek-ai/dsh-llm'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'

const PROVIDERS_STORAGE_KEY = 'dsh-edge:configured-providers'

/** One user-configured LLM provider stored in DO KV. */
export interface EdgeProviderEntry {
  id: string
  name: string
  baseURL: string
  apiKeyRef: string
  models: { id: string; name: string }[]
}

/** Read configured providers from Durable Object storage. */
export async function readConfiguredProviders(
  storage: DurableObjectStorage,
): Promise<EdgeProviderEntry[]> {
  const stored = await storage.get(PROVIDERS_STORAGE_KEY)
  if (!Array.isArray(stored)) return []
  return stored.filter(isValidProviderEntry)
}

/** Persist configured providers to Durable Object storage. */
export async function writeConfiguredProviders(
  storage: DurableObjectStorage,
  providers: EdgeProviderEntry[],
): Promise<void> {
  await storage.put(PROVIDERS_STORAGE_KEY, providers)
}

/** Register configured providers as LLM adapters on the cordis context. */
export function installConfiguredProviders(
  ctx: Context,
  entries: readonly EdgeProviderEntry[],
  resolveAttachments?: () => AttachmentStore | undefined,
): () => void {
  const disposers: (() => void)[] = []

  for (const entry of entries) {
    if (entry.id.length === 0 || entry.baseURL.length === 0) continue
    const adapter = createProviderAdapter(ctx, entry, resolveAttachments)
    const handle = ctx.llm.registerAdapter([entry.id], adapter)
    disposers.push(handle)
  }

  let configurableDispose: (() => void) | undefined
  const configurableEntries = entries
    .filter(entry => entry.id.length > 0 && entry.baseURL.length > 0)
    .map(entry => ({
      provider: entry.id,
      displayName: entry.name || entry.id,
      settingsNs: 'edge-providers',
      settingsPath: ['providers'] as readonly string[],
      declared: true as const,
    }))

  if (configurableEntries.length > 0) {
    try {
      const handle = ctx.llm.registerConfigurableProviders(configurableEntries)
      configurableDispose = handle
    } catch {
      // Advisory; failure does not block turns.
    }
  }

  return () => {
    for (const dispose of disposers) dispose()
    configurableDispose?.()
  }
}

function createProviderAdapter(
  ctx: Context,
  entry: EdgeProviderEntry,
  resolveAttachments?: () => AttachmentStore | undefined,
): DeepSeekAdapter {
  const ref = (entry.apiKeyRef || `${entry.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`) as CredentialRef
  const connection = resolveAdapterOptions({
    apiKeyEnv: ref,
    baseURL: entry.baseURL,
  })
  const anonymousRequestId = crypto.randomUUID() as AnonymousUserId
  return new DeepSeekAdapter({
    options: () => ({
      ...connection,
      models: entry.models.map(m => ({
        id: m.id,
        ...m.name ? { name: m.name } : {},
      })),
    }),
    resolveApiKey: async () => {
      const resolved = await ctx.credentials.resolve(ref)
      if (resolved === undefined) {
        throw new LlmError(
          `dsh-edge: no API key for provider "${entry.id}"; store ${String(ref)} through the credentials service`,
          'MISSING_CREDENTIAL',
        )
      }
      return assertUsableApiKey(resolved.value, 'dsh-edge', ref)
    },
    resolveUserId: () => anonymousRequestId,
    ...resolveAttachments === undefined
      ? {}
      : { resolveAttachments },
  })
}

function isValidProviderEntry(value: unknown): value is EdgeProviderEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry['id'] === 'string' && entry['id'].length > 0
    && typeof entry['name'] === 'string'
    && typeof entry['baseURL'] === 'string' && entry['baseURL'].length > 0
    && typeof entry['apiKeyRef'] === 'string'
    && Array.isArray(entry['models'])
}
