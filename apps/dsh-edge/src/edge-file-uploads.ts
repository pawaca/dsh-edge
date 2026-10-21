/**
 * Upstream file uploads with receipts that survive a Durable Object restart.
 *
 * Upstream keeps upload receipts in memory with the session's Agent, which
 * lasts as long as its server process. A Durable Object with hibernatable
 * WebSockets is evicted whenever it idles, often while the page stays open,
 * so a file uploaded before a pause would be refused at send time as not
 * staged although its bytes are stored. The Edge records each receipt in one
 * Durable Object row and, when a prompt names a receipt the live Agent no
 * longer holds, restores it into upstream's registry, so upstream's binding,
 * rollback, and retirement apply unchanged. The row is deleted when its
 * prompt is recorded or retired; unsent receipts expire after a week.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  FileUploads,
  type FileUploadReceiptId,
  type FileUploadValue,
  type PromptFileBinding,
} from '@deepseek-ai/dsh-client-file-upload'
import type { SessionId } from '@deepseek-ai/dsh-session'

export const UPLOAD_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Expired receipts deleted per recorded upload, so cleanup stays bounded. */
const EXPIRED_RECEIPTS_PER_UPLOAD = 20

interface ReceiptRow extends Record<string, SqlStorageValue> {
  attachment_id: string
  name: string
  bytes: number
  request_id: string | null
}

/** Upstream's in-memory registry, which restored receipts rejoin. */
type StagedFiles = WeakMap<object, Map<string, { file: FileAttachmentRef; requestId?: string }>>

export interface EdgeFileUploadsConfig {
  storage: DurableObjectStorage
  now?: () => number
}

export class EdgeFileUploads extends FileUploads {
  private readonly storage: DurableObjectStorage
  private readonly now: () => number

  constructor(ctx: Context, config: EdgeFileUploadsConfig) {
    super(ctx)
    this.storage = config.storage
    this.now = config.now ?? Date.now
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_edge_upload_receipts (
      receipt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      name TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      request_id TEXT,
      created_at INTEGER NOT NULL
    ) STRICT`)
    // Retiring a recorded message and expiring old receipts each look rows up
    // by these columns, so neither scans the receipts other uploads retain.
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS dsh_edge_upload_receipts_request ON dsh_edge_upload_receipts (session_id, request_id)')
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS dsh_edge_upload_receipts_created ON dsh_edge_upload_receipts (created_at)')
    // As upstream retires a bound receipt once its user message is recorded.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'user' || !('rpcId' in event.data.source)) return
      const rpcId = event.data.source.rpcId
      if (typeof rpcId === 'string') this.forget(String(session.header.id), rpcId)
    })
  }

  override async upload(agent: Agent, request: Parameters<FileUploads['upload']>[1], signal: AbortSignal): Promise<FileUploadValue> {
    return this.record(agent.id, await super.upload(agent, request, signal))
  }

  override async uploadStream(request: Parameters<FileUploads['uploadStream']>[0]): Promise<FileUploadValue> {
    return this.record(request.sessionId, await super.uploadStream(request))
  }

  override resolve(agent: Agent, receiptId: FileUploadReceiptId): FileAttachmentRef | undefined {
    const live = super.resolve(agent, receiptId)
    if (live !== undefined) return live
    const stored = this.stored(String(agent.id), String(receiptId))
    if (stored === undefined) return undefined
    const staged = (this as unknown as { stagedFiles: StagedFiles }).stagedFiles
    let session = staged.get(agent.session)
    if (session === undefined) {
      session = new Map()
      staged.set(agent.session, session)
    }
    // A receipt already bound to a queued prompt keeps that binding, so the
    // prompt's recorded message retires it as upstream's would.
    session.set(String(receiptId), stored.requestId === undefined ? { file: stored.file } : { file: stored.file, requestId: stored.requestId })
    return stored.file
  }

  /**
   * Bind receipts of a session without a live Agent, from their rows alone, as
   * a prompt queued for a cold session is. The rows retire when its message is
   * recorded, as live bindings do.
   * @returns the stored files in receipt order, or undefined when any receipt is unknown.
   */
  bindStoredPrompt(
    sessionId: SessionId,
    receiptIds: readonly string[],
    requestId: string,
  ): { readonly files: readonly FileAttachmentRef[]; readonly binding: PromptFileBinding } | undefined {
    const files: FileAttachmentRef[] = []
    for (const receiptId of receiptIds) {
      const stored = this.stored(String(sessionId), receiptId)
      if (stored === undefined) return undefined
      files.push(stored.file)
    }
    return { files, binding: this.bindRows([...new Set(receiptIds)], requestId, { commit() {}, [Symbol.dispose]() {} }) }
  }

  override bindPrompt(agent: Agent, receiptIds: readonly FileUploadReceiptId[], requestId: string): PromptFileBinding {
    return this.bindRows(receiptIds.map(String), requestId, super.bindPrompt(agent, receiptIds, requestId))
  }

  override retirePrompt(agent: Agent, requestId: string): void {
    super.retirePrompt(agent, requestId)
    this.forget(String(agent.id), requestId)
  }

  private stored(sessionId: string, receiptId: string): { file: FileAttachmentRef; requestId?: string } | undefined {
    const row = this.storage.sql.exec<ReceiptRow>(
      `SELECT attachment_id, name, bytes, request_id FROM dsh_edge_upload_receipts
       WHERE receipt_id = ? AND session_id = ? AND created_at >= ?`,
      receiptId, sessionId, this.now() - UPLOAD_RECEIPT_RETENTION_MS,
    ).toArray()[0]
    if (row === undefined) return undefined
    const file: FileAttachmentRef = { attachmentId: AttachmentId(row.attachment_id), name: row.name, bytes: row.bytes }
    return row.request_id === null ? { file } : { file, requestId: row.request_id }
  }

  /** Record the binding on the receipts' rows too, restoring them if it rolls back. */
  private bindRows(ids: readonly string[], requestId: string, binding: PromptFileBinding): PromptFileBinding {
    let previous: Map<string, string | null>
    try {
      // All rows change or none do, so a failed write (a spent quota) leaves
      // no receipt bound to a prompt that was refused.
      previous = this.storage.transactionSync(() => {
        const before = new Map(ids.map(id => [id, this.storage.sql.exec<{ request_id: string | null }>(
          'SELECT request_id FROM dsh_edge_upload_receipts WHERE receipt_id = ?', id,
        ).toArray()[0]?.request_id ?? null]))
        for (const id of ids) {
          this.storage.sql.exec('UPDATE dsh_edge_upload_receipts SET request_id = ? WHERE receipt_id = ?', requestId, id)
        }
        return before
      })
    } catch (error) {
      // Undo upstream's in-memory binding too: the caller never receives it.
      binding[Symbol.dispose]()
      throw error
    }
    let committed = false
    return {
      commit: () => {
        committed = true
        binding.commit()
      },
      [Symbol.dispose]: () => {
        binding[Symbol.dispose]()
        if (committed) return
        this.storage.transactionSync(() => {
          for (const [id, request] of previous) {
            this.storage.sql.exec('UPDATE dsh_edge_upload_receipts SET request_id = ? WHERE receipt_id = ?', request, id)
          }
        })
      },
    }
  }

  private record(sessionId: SessionId, value: FileUploadValue): FileUploadValue {
    const now = this.now()
    this.storage.sql.exec(
      `DELETE FROM dsh_edge_upload_receipts WHERE receipt_id IN (
         SELECT receipt_id FROM dsh_edge_upload_receipts WHERE created_at < ? LIMIT ?)`,
      now - UPLOAD_RECEIPT_RETENTION_MS, EXPIRED_RECEIPTS_PER_UPLOAD,
    )
    this.storage.sql.exec(
      `INSERT INTO dsh_edge_upload_receipts (receipt_id, session_id, attachment_id, name, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      String(value.receiptId), String(sessionId), String(value.file.attachmentId), value.file.name, value.file.bytes, now,
    )
    return value
  }

  /** Retire a request's stored receipts for a session without a live Agent. */
  retireStoredPrompt(sessionId: SessionId, requestId: string): void {
    this.forget(String(sessionId), requestId)
  }

  private forget(sessionId: string, requestId: string): void {
    this.storage.sql.exec('DELETE FROM dsh_edge_upload_receipts WHERE session_id = ? AND request_id = ?', sessionId, requestId)
  }
}

export default EdgeFileUploads
