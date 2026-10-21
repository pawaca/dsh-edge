/**
 * Verbatim file attachments in the workspace Computer VFS, the Edge port of
 * upstream's local file store (`dsh-attachment-local`). Upstream keeps each
 * upload below `DSH_HOME/attachments/v1/files/<prefix>/<digest>/<name>` and
 * tells the model that path, so its file tools read the bytes. The Edge keeps
 * the same layout below `/.dsh/attachments/v1`, which the light shell, the
 * file tools, and `/api/file` already reach. A Linux Container mounts only
 * `/workspace`, so commands routed there do not see these files.
 *
 * Bytes stream from the request into the VFS (one 512 KiB chunk row at a
 * time) while an incremental SHA-256 runs over them, then the staged object is
 * renamed to its content address. Reads stream back in VFS chunks and verify
 * the length and digest. Neither direction holds a whole file in memory.
 */

import { createHash } from 'node:crypto'
import {
  AttachmentError,
  AttachmentId,
  type FileAttachmentRef,
  type SaveFileStreamAttachment,
} from '@deepseek-ai/dsh-attachment'

export const EDGE_FILE_ATTACHMENT_ROOT = '/.dsh/attachments/v1'
/** Upstream's streaming upload route (`dsh-client-file-upload`). */
export const FILE_UPLOAD_PATH = '/api/session/uploadFileBinary'
/**
 * Upstream admits files of any length. One Edge upload is one Worker request
 * (Cloudflare caps those at 100 MB on most plans) whose bytes land in the
 * instance's Durable Object storage, so the Edge bounds each file.
 */
export const EDGE_MAX_FILE_ATTACHMENT_BYTES = 64 * 1024 * 1024

const FILE_ID_PATTERN = /^sha256:([a-f0-9]{64})$/u
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

/** The VFS operations the file store drives. */
export interface EdgeAttachmentFiles {
  writeFile(path: string, content: ReadableStream<Uint8Array>): Promise<void>
  readFile(path: string): Promise<ReadableStream<Uint8Array>>
  stat(path: string): Promise<{ size: number; isFile: boolean }>
  mkdir(path: string, options: { recursive: true }): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
}

/** Borrow the workspace VFS; disposing the lease releases it. */
export type OpenAttachmentFiles = () => Promise<{
  readonly files: EdgeAttachmentFiles
  [Symbol.dispose](): void
}>

/**
 * Sanitize a caller display name into the stored leaf name, as upstream's
 * `fileLeafName` does: both separator styles are stripped, control and
 * Windows-reserved characters are removed or replaced, and the result is cut
 * to 255 UTF-8 bytes.
 */
export function fileLeafName(value: string | undefined): string {
  if (value === undefined) return 'file'
  // Upstream drops C0 controls and DEL, not the C1 range \p{Cc} would also match.
  let clean = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
    .split('')
    .filter(character => character > '\u001f' && character !== '\u007f')
    .join('')
    .replace(/[<>:"|?*]/gu, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  if (isWindowsDeviceName(clean)) clean = `_${clean}`
  clean = utf8Prefix(clean, 255).replace(/[. ]+$/u, '')
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean
}

/** The VFS path the model reads one stored file from. */
export function storedFilePath(ref: FileAttachmentRef): string {
  const sha256 = referenceDigest(ref)
  return `${EDGE_FILE_ATTACHMENT_ROOT}/files/${sha256.slice(0, 2)}/${sha256}/${ref.name}`
}

/** Whether a VFS path names a stored file, so it can be shown to the model as-is. */
export function isStoredFilePath(path: string): boolean {
  return path.startsWith(`${EDGE_FILE_ATTACHMENT_ROOT}/files/`)
}

/**
 * Stream one file into the VFS under its content address. The bytes are
 * staged under a random name while they are hashed, so a failed or aborted
 * upload leaves no object at any content address.
 */
export async function saveFileStream(
  open: OpenAttachmentFiles,
  input: SaveFileStreamAttachment,
  maxBytes = EDGE_MAX_FILE_ATTACHMENT_BYTES,
): Promise<FileAttachmentRef> {
  input.signal?.throwIfAborted()
  const name = fileLeafName(input.name)
  using lease = await open()
  const { files } = lease
  const staging = `${EDGE_FILE_ATTACHMENT_ROOT}/staging`
  const staged = `${staging}/${crypto.randomUUID()}`
  const hash = createHash('sha256')
  const iterator = input.data[Symbol.asyncIterator]()
  let bytes = 0
  let tooLarge = false
  // Pulled by the VFS writer one chunk at a time, so the request body is read
  // no faster than chunks are stored.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      input.signal?.throwIfAborted()
      const next = await iterator.next()
      if (next.done === true) {
        controller.close()
        return
      }
      bytes += next.value.byteLength
      if (bytes > maxBytes) {
        tooLarge = true
        throw tooLargeError(maxBytes)
      }
      hash.update(next.value)
      controller.enqueue(next.value)
    },
    async cancel() {
      await iterator.return?.()
    },
  }, { highWaterMark: 0 })
  try {
    await files.mkdir(staging, { recursive: true })
    await files.writeFile(staged, body)
    input.signal?.throwIfAborted()
    const ref: FileAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${hash.digest('hex')}`),
      name,
      bytes,
    }
    const target = storedFilePath(ref)
    await files.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    // An existing object at this address is replaced, so a damaged copy heals.
    await files.rm(target, { force: true })
    await files.rename(staged, target)
    return ref
  } catch (error) {
    await files.rm(staged, { force: true }).catch(() => undefined)
    await iterator.return?.().catch(() => undefined)
    input.signal?.throwIfAborted()
    if (error instanceof AttachmentError) throw error
    if (tooLarge) throw tooLargeError(maxBytes)
    throw new AttachmentError('Unable to store file attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
}

/** Stream one stored file back, verifying its length and digest. */
export async function* readFileStream(
  open: OpenAttachmentFiles,
  ref: FileAttachmentRef,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted()
  const sha256 = referenceDigest(ref)
  const path = storedFilePath(ref)
  using lease = await open()
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    const info = await lease.files.stat(path)
    if (!info.isFile || info.size !== ref.bytes) {
      throw new AttachmentError('Stored file attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
    }
    reader = (await lease.files.readFile(path)).getReader()
  } catch (error) {
    throw readFailure(error, signal)
  }
  const hash = createHash('sha256')
  let bytes = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch (error) {
        throw readFailure(error, signal)
      }
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > ref.bytes) {
        throw new AttachmentError('Stored file attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
      }
      hash.update(next.value)
      yield next.value
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  signal?.throwIfAborted()
  if (bytes !== ref.bytes || hash.digest('hex') !== sha256) {
    throw new AttachmentError('Stored file attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  }
}

/** Upstream has no size code; the write fails with a message naming the limit. */
function tooLargeError(maxBytes: number): AttachmentError {
  return new AttachmentError(
    `Files are limited to ${String(maxBytes / 1024 / 1024)} MiB on this Edge instance.`,
    'ATTACHMENT_WRITE_FAILED',
  )
}

function readFailure(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted === true) return signal.reason
  if (error instanceof AttachmentError) return error
  if (error instanceof Error && 'code' in error && (error as { code: unknown }).code === 'ENOENT') {
    return new AttachmentError('File attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
  }
  return new AttachmentError('Unable to read file attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
}

function referenceDigest(ref: FileAttachmentRef): string {
  const match = FILE_ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined || ref.name !== fileLeafName(ref.name)) {
    throw new AttachmentError('File attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  }
  return match[1]
}

function isWindowsDeviceName(name: string): boolean {
  const dot = name.indexOf('.')
  const stem = (dot < 0 ? name : name.slice(0, dot)).replace(/[. ]+$/u, '')
  return WINDOWS_DEVICE_NAME.test(stem)
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  let bytes = 0
  let prefix = ''
  for (const character of value) {
    const size = encoder.encode(character).byteLength
    if (bytes + size > maxBytes) break
    prefix += character
    bytes += size
  }
  return prefix
}
