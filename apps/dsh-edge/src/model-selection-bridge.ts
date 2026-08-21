/** Durable Object bridge for a model choice not yet recorded in a request/header event. */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

const STORAGE_KEY_PREFIX = 'dsh-edge:session-model:'

/** Keep the pre-turn choice durable without creating a second session schema. */
export class EdgeModelSelectionBridge {
  private readonly cache = new Map<SessionId, ModelSelection>()

  constructor(private readonly storage: DurableObjectStorage) {}

  /** Return the process-local value after the owning session has been hydrated. */
  current(id: SessionId): ModelSelection | undefined {
    return this.cache.get(id)
  }

  /** Update the process-local face used by the upstream ModelSelectionRef. */
  setCurrent(id: SessionId, selection: ModelSelection | undefined): void {
    if (selection === undefined) this.cache.delete(id)
    else this.cache.set(id, selection)
  }

  /** Hydrate one pending choice after Durable Object hibernation. */
  async load(id: SessionId): Promise<ModelSelection | undefined> {
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached
    const stored = parseStoredModelSelection(await this.storage.get(storageKey(id)))
    if (stored !== undefined) this.cache.set(id, stored)
    return stored
  }

  /** Persist an accepted choice before reporting success to the client. */
  async save(id: SessionId, selection: ModelSelection): Promise<void> {
    await this.storage.put(storageKey(id), selection)
    this.cache.set(id, selection)
  }

  /**
   * Remove the pending bridge once the same selection exists in the canonical log.
   * The transaction prevents an older turn from deleting a newer concurrent choice.
   */
  async clearIfLogged(id: SessionId, logged: ModelSelection): Promise<boolean> {
    const canonicalized = await this.storage.transaction(async (transaction) => {
      const raw = await transaction.get(storageKey(id))
      if (raw === undefined) return true
      const stored = parseStoredModelSelection(raw)
      if (stored !== undefined && !sameModelSelection(stored, logged)) return false
      await transaction.delete(storageKey(id))
      return true
    })
    if (canonicalized && sameModelSelection(this.cache.get(id), logged)) {
      this.cache.delete(id)
    }
    return canonicalized
  }
}

function storageKey(id: SessionId): string {
  return `${STORAGE_KEY_PREFIX}${id}`
}

/** Treat malformed adapter-owned KV as absent so canonical session logs remain recoverable. */
function parseStoredModelSelection(value: unknown): ModelSelection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (typeof fields['provider'] !== 'string' || fields['provider'].length === 0) return undefined
  if (typeof fields['model'] !== 'string' || fields['model'].length === 0) return undefined
  const reasoningEffort = fields['reasoningEffort']
  if (reasoningEffort !== undefined
    && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) return undefined
  return {
    provider: fields['provider'],
    model: fields['model'],
    ...reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
  }
}

function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return left?.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

export default EdgeModelSelectionBridge
