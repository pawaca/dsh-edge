/**
 * The session log download (`/api/session.export`), paged.
 *
 * Upstream's `dsh-session-log-export` reads a session's whole log into memory
 * and joins it into one string before compressing it, which holds 4 to 6 times
 * the stored event bytes on the heap; a Durable Object has 128 MB for every
 * session it runs, so a large log would restart it. The Edge keeps upstream's
 * plugin for the `/export` command and its route registration, and answers the
 * download here instead: each log is read a page at a time and each page is
 * written into the ZIP stream before the next is read, so memory follows the
 * page size and not the log (#317).
 *
 * The archive matches upstream's (pinned by `edge-session-log-export.spec.ts`
 * against upstream's own exporter): `session[.vN].jsonl` with one header line
 * and one line per event, `subagents/<id>/session[.vN].jsonl` for each
 * descendant in lineage order, then `media/<attachmentId>.<ext>` for each
 * referenced image and `files/<prefix>/<digest>/<name>` for each referenced
 * file. What upstream keeps internal (collecting attachment references and
 * streaming the ZIP with backpressure) is ported from
 * `@deepseek-ai/dsh-session-log-export@0.2.1-rc.3` (unchanged since 0.2.1-rc.2); recheck it on a baseline upgrade.
 */

import type { FileAttachmentRef, ImageAttachmentRef, ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_LOG_FILENAME, serializeSessionLog, sessionLogZipFilename } from '@deepseek-ai/dsh-session-log-export'
import { Zip, ZipDeflate } from 'fflate'

/**
 * One page of a log. Events are a few hundred bytes to a few KiB each, and a
 * tool result can be a few hundred KiB; a page stops after the row that brings
 * it to 256 Ki characters of stored data, so a page, its JSONL text, and its
 * encoded bytes stay around a few MiB however large the log is.
 */
export const SESSION_LOG_EXPORT_PAGE = { rows: 256, characters: 256 * 1024 } as const

/** Upstream's default DEFLATE level, which the Edge mounts the export with. */
export const SESSION_LOG_EXPORT_COMPRESSION_LEVEL = 6

/** One node of a session's subagent lineage, as `sessionQuery.traceSession` returns it. */
export interface SessionLogLineageNode {
  readonly session: { readonly header: { readonly id: SessionId } }
  readonly descendants: readonly SessionLogLineageNode[]
}

export interface SessionLogExportSources {
  /** Save a live session's pending events, as upstream does before each log read. */
  flush(id: SessionId, signal: AbortSignal): Promise<void>
  /** The session's header (blank sessions included), or `undefined` when it does not exist. */
  header(id: SessionId, signal: AbortSignal): Promise<SessionHeader | undefined>
  /** The session's committed log in pages, pinned when the first page is read. */
  pages(id: SessionId, signal: AbortSignal): AsyncIterable<readonly SessionEvent[]>
  /** The session's subagent lineage. */
  descendants(id: SessionId, signal: AbortSignal): Promise<readonly SessionLogLineageNode[]>
  readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<StoredImageAttachment>
  readFileStream(ref: FileAttachmentRef, signal: AbortSignal): AsyncIterable<Uint8Array>
}

/**
 * Answer one download as upstream's route does: 404 for a session that does
 * not exist and 500 when its log cannot be opened, both before any archive
 * byte; afterwards a failed read ends the stream with an error, never with a
 * partial archive that looks complete.
 */
export async function sessionLogExportResponse(
  sources: SessionLogExportSources,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal: AbortSignal,
): Promise<Response> {
  let header: SessionHeader | undefined
  try {
    await sources.flush(sessionId, signal)
    header = await sources.header(sessionId, signal)
    signal.throwIfAborted()
  } catch {
    signal.throwIfAborted()
    return new Response('session log export failed to read the stored log', { status: 500 })
  }
  if (header === undefined) return new Response('session not found', { status: 404 })
  return new Response(streamArchive(sources, header, sessionId, includeDescendants, signal), { headers: {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
  } })
}

/** One archive entry: a log written page by page, an image, or a streamed file. */
type ArchiveEntry =
  | { readonly path: string; readonly log: { readonly id: SessionId; readonly header: SessionHeader } }
  | { readonly path: string; readonly data: Uint8Array }
  | { readonly path: string; readonly chunks: AsyncIterable<Uint8Array> }

/** Archive entries in upstream's order; attachments follow the logs that name them. */
async function* archiveEntries(
  sources: SessionLogExportSources,
  root: SessionHeader,
  sessionId: SessionId,
  includeDescendants: boolean,
  refs: AttachmentRefs,
  signal: AbortSignal,
): AsyncGenerator<ArchiveEntry> {
  yield { path: SESSION_LOG_FILENAME, log: { id: sessionId, header: root } }
  if (includeDescendants) {
    const seen = new Set<SessionId>([sessionId])
    const collect = async function* (nodes: readonly SessionLogLineageNode[]): AsyncGenerator<ArchiveEntry> {
      for (const node of nodes) {
        signal.throwIfAborted()
        const id = node.session.header.id
        if (seen.has(id)) continue
        seen.add(id)
        await sources.flush(id, signal)
        const header = await sources.header(id, signal)
        signal.throwIfAborted()
        if (header === undefined) throw new Error(`subagent "${String(id)}" has no stored log`)
        yield { path: `subagents/${safeSessionIdSegment(id)}/${SESSION_LOG_FILENAME}`, log: { id, header } }
        yield* collect(node.descendants)
      }
    }
    const lineage = await sources.descendants(sessionId, signal)
    signal.throwIfAborted()
    yield* collect(lineage)
  }
  for (const ref of refs.images.values()) {
    signal.throwIfAborted()
    const stored = await sources.readImage(ref, signal)
    signal.throwIfAborted()
    yield { path: mediaEntryPath(ref), data: stored.data }
  }
  for (const ref of refs.files.values()) {
    signal.throwIfAborted()
    yield { path: fileEntryPath(ref), chunks: sources.readFileStream(ref, signal) }
  }
}

/** Bytes of one push into a ZIP entry, and of the response queue before production waits for the reader. */
const PUSH_CHUNK_BYTES = 65_536
const RESPONSE_HIGH_WATER_MARK_BYTES = 65_536

function streamArchive(
  sources: SessionLogExportSources,
  root: SessionHeader,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const consumerAbort = new AbortController()
  const producerSignal = AbortSignal.any([signal, consumerAbort.signal])
  const capacity = new ResponseCapacityGate()
  let zip: Zip | undefined
  let zipTerminated = false
  const terminateZip = () => {
    if (zip === undefined || zipTerminated) return
    zipTerminated = true
    zip.terminate()
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const archive = new Zip((error, data, final) => {
        if (error) {
          controller.error(error)
          return
        }
        if (data.byteLength > 0) controller.enqueue(data)
        if (final) controller.close()
      })
      zip = archive
      const encoder = new TextEncoder()
      const refs: AttachmentRefs = { images: new Map(), files: new Map() }
      const push = async (deflate: ZipDeflate, bytes: Uint8Array, final: boolean) => {
        for (let offset = 0; offset < bytes.byteLength || (final && offset === 0); offset += PUSH_CHUNK_BYTES) {
          producerSignal.throwIfAborted()
          const end = Math.min(offset + PUSH_CHUNK_BYTES, bytes.byteLength)
          deflate.push(bytes.subarray(offset, end), final && end >= bytes.byteLength)
          await capacity.wait(controller, producerSignal)
        }
      }
      void (async () => {
        try {
          for await (const entry of archiveEntries(sources, root, sessionId, includeDescendants, refs, producerSignal)) {
            const deflate = new ZipDeflate(entry.path, { level: SESSION_LOG_EXPORT_COMPRESSION_LEVEL })
            archive.add(deflate)
            if ('log' in entry) {
              // Upstream's header line, then one line per event as each page arrives.
              await push(deflate, encoder.encode(serializeSessionLog(entry.log.header, [])), false)
              for await (const page of sources.pages(entry.log.id, producerSignal)) {
                let text = ''
                for (const event of page) {
                  collectEventAttachmentRefs(event, refs)
                  text += `${JSON.stringify(event)}\n`
                }
                await push(deflate, encoder.encode(text), false)
              }
              await push(deflate, new Uint8Array(), true)
            } else if ('data' in entry) {
              await push(deflate, entry.data, true)
            } else {
              for await (const chunk of entry.chunks) {
                if (chunk.byteLength > 0) await push(deflate, chunk, false)
              }
              await push(deflate, new Uint8Array(), true)
            }
          }
          archive.end()
        } catch (error) {
          terminateZip()
          controller.error(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    },
    pull() {
      capacity.pulled()
    },
    cancel(reason) {
      consumerAbort.abort(reason instanceof Error ? reason : new Error('session log export stream cancelled'))
      terminateZip()
    },
  }, {
    highWaterMark: RESPONSE_HIGH_WATER_MARK_BYTES,
    size: chunk => chunk.byteLength,
  })
}

/** Holds production while the response queue is full, until the reader pulls or the export is cancelled. */
class ResponseCapacityGate {
  private releasePending: (() => void) | undefined

  async wait(controller: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (controller.desiredSize === null || controller.desiredSize > 0) return
    await new Promise<void>((resolve) => {
      const release = () => {
        this.releasePending = undefined
        signal.removeEventListener('abort', release)
        resolve()
      }
      this.releasePending = release
      signal.addEventListener('abort', release, { once: true })
    })
    signal.throwIfAborted()
  }

  pulled(): void {
    this.releasePending?.()
  }
}

interface AttachmentRefs {
  /** By attachment id: one archive entry per image however many events show it. */
  readonly images: Map<string, ImageAttachmentRef>
  /** By attachment id and stored name. */
  readonly files: Map<string, FileAttachmentRef>
}

const MEDIA_TYPE_EXTENSIONS: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

function mediaEntryPath(ref: ImageAttachmentRef): string {
  return `media/${String(ref.attachmentId)}.${MEDIA_TYPE_EXTENSIONS[ref.mediaType]}`
}

function fileEntryPath(ref: FileAttachmentRef): string {
  const digest = String(ref.attachmentId).replace(/^sha256:/u, '')
  // eslint-disable-next-line no-control-regex
  const name = ref.name.replace(/[\\/\u0000-\u001f\u007f]/gu, '_')
  const safeName = name === '.' || name === '..' || name === '' ? 'file' : name
  return `files/${digest.slice(0, 2)}/${digest}/${safeName}`
}

function safeSessionIdSegment(id: SessionId): string {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_')
}

type Fields = Record<string, unknown>
const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Image and file blocks of one content array. */
function collectAttachmentRefs(content: unknown, refs: AttachmentRefs): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isObject(block) || !isObject(block.attachment)) continue
    if (block.type === 'image') {
      const ref = block.attachment as unknown as ImageAttachmentRef
      refs.images.set(String(ref.attachmentId), ref)
    }
    if (block.type === 'file') {
      const ref = block.attachment as unknown as FileAttachmentRef
      refs.files.set(`${String(ref.attachmentId)}\u0000${ref.name}`, ref)
    }
  }
}

/**
 * The attachments one event names, from the same fields upstream reads: the
 * declared content of each first-party message event and the completed blocks
 * of an assistant attempt. Other events and fields are left alone.
 */
function collectEventAttachmentRefs(event: SessionEvent, refs: AttachmentRefs): void {
  const data = (event as { data?: unknown }).data
  if (!isObject(data)) return
  const message = isObject(data.message) ? data.message : undefined
  // Upstream also names event types this baseline's session catalog does not declare.
  switch (event.type as string) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      collectAttachmentRefs(data.content, refs)
      return
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
    case 'team/message/queued':
      collectAttachmentRefs(message?.content, refs)
      return
    case 'agent/inbox/spliced':
      if (!Array.isArray(data.inserted)) return
      for (const inserted of data.inserted) if (isObject(inserted)) collectAttachmentRefs(inserted.content, refs)
      return
    case 'compaction/summary':
      collectAttachmentRefs(data.summary, refs)
      collectAttachmentRefs(data.rawOutput, refs)
      return
    case 'assistant/message':
      collectAttachmentRefs(message?.content, refs)
      break
    case 'assistant/attempt':
      break
    default:
      return
  }
  if (!Array.isArray(data.stream)) return
  for (const record of data.stream) {
    if (isObject(record) && record.type === 'chunk' && isObject(record.chunk) && record.chunk.type === 'block-end') {
      collectAttachmentRefs([record.chunk.block], refs)
    }
  }
}
