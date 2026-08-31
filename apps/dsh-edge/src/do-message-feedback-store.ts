/** Point-read Durable Object storage for upstream message feedback rows. */

import {
  messageFeedbackRowSchema,
  type MessageFeedbackRow,
  type MessageFeedbackStore,
} from '@deepseek-ai/dsh-message-feedback'
import { StorageError } from '@deepseek-ai/dsh-storage'

const MESSAGE_FEEDBACK_UNIT = 'message_feedback'
const MESSAGE_FEEDBACK_VERSION = 0
const VERSION_KEY = `dsh-kv:${MESSAGE_FEEDBACK_UNIT}:__version__`
const RECORD_PREFIX = `dsh-kv:${MESSAGE_FEEDBACK_UNIT}:sessions:`

function recordKey(sessionId: string): string {
  return `${RECORD_PREFIX}${sessionId}`
}

/**
 * Preserves the storage-domain key schema without materializing every retained
 * feedback row when a Durable Object starts.
 */
export class DurableObjectMessageFeedbackStore implements MessageFeedbackStore {
  private readonly ready: Promise<void>

  constructor(private readonly storage: DurableObjectStorage) {
    this.ready = this.ensureVersion()
  }

  async get(sessionId: string): Promise<MessageFeedbackRow | undefined> {
    await this.ready
    const value = await this.storage.get(recordKey(sessionId))
    if (value === undefined) return undefined
    const parsed = messageFeedbackRowSchema.safeParse(value)
    if (!parsed.success) {
      throw new StorageError(
        'malformed-medium',
        `message feedback row '${sessionId}' does not match its schema`,
        { cause: parsed.error },
      )
    }
    return parsed.data
  }

  async put(sessionId: string, row: MessageFeedbackRow): Promise<void> {
    await this.ready
    await this.storage.put(recordKey(sessionId), row)
  }

  private async ensureVersion(): Promise<void> {
    const storedVersion = await this.storage.get(VERSION_KEY)
    if (storedVersion === undefined) {
      await this.storage.put(VERSION_KEY, MESSAGE_FEEDBACK_VERSION)
      return
    }
    if (storedVersion !== MESSAGE_FEEDBACK_VERSION) {
      throw new StorageError(
        'version-mismatch',
        `unit '${MESSAGE_FEEDBACK_UNIT}' medium version ${JSON.stringify(storedVersion)} does not match descriptor version ${MESSAGE_FEEDBACK_VERSION}`,
      )
    }
  }
}
