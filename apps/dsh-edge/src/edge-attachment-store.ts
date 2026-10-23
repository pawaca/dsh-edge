/** Cloudflare implementations of the upstream durable attachment seam. */

import {
  AttachmentError,
  AttachmentId,
  AttachmentStore,
  ImageVariantId,
  type FileAttachmentRef,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageRequestTarget,
  type ImageMediaType,
  type SaveFileAttachment,
  type SaveFileStreamAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { decode as decodePng } from 'fast-png'
import { decode as decodeJpeg } from 'jpeg-js'
import * as EdgeFileAttachments from './edge-file-attachments.ts'
import {
  normalizeWithImages,
  passesThrough,
  readImageHeader,
  responseBytes,
  type ImageHeader,
  type ImagesBinding,
} from './edge-image-normalization.ts'

export type { ImagesBinding } from './edge-image-normalization.ts'

const DEFAULT_MAX_IMAGE_BYTES = 3.5 * 1024 * 1024
const DEFAULT_MAX_IMAGES_PER_MESSAGE = 4
const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 7 * 1024 * 1024
const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000
const DEFAULT_MAX_IMAGE_DIMENSION = 2_000
const R2_OBJECT_PREFIX = 'attachments/v1/objects'
const DO_ATTACHMENT_SCHEMA_VERSION = 1
const DO_ATTACHMENT_CHUNK_BYTES = 512 * 1024
export const EDGE_DO_ATTACHMENT_MAX_STORED_BYTES = 64 * 1024 * 1024
const ATTACHMENT_ID_PATTERN = /^sha256:([a-f0-9]{64})$/u

/** Stable upstream projection advertised whenever the R2 service is mounted. */
export const EDGE_R2_IMAGE_LIMITS: ImageAttachmentLimits = Object.freeze({
  maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
  maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
  maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
  maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION,
  // The Worker validators fully decode these formats without native modules.
  mediaTypes: Object.freeze(['image/png', 'image/jpeg'] satisfies ImageMediaType[]),
})

/** Temporary deployments keep the same user-facing admission contract as R2. */
export const EDGE_DO_IMAGE_LIMITS: ImageAttachmentLimits = EDGE_R2_IMAGE_LIMITS

/**
 * Admission with the Cloudflare Images binding, which normalizes what the
 * Worker cannot decode (edge-image-normalization.ts). Formats, pixels, and
 * sides are upstream's. Bytes are not: images arrive base64 inside the 10 MiB
 * prompt body (MAX_TURN_BODY_BYTES), held whole in the Durable Object, so one
 * message carries at most 7 MiB of images, where upstream allows 20 MiB each.
 */
export const EDGE_OPTIMIZED_IMAGE_LIMITS: ImageAttachmentLimits = Object.freeze({
  maxImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  maxImagesPerMessage: 8,
  maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8_192,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] satisfies ImageMediaType[]),
})

/** The admission limits of a store with or without the Images binding. */
export function edgeImageLimits(optimized: boolean): ImageAttachmentLimits {
  return optimized ? EDGE_OPTIMIZED_IMAGE_LIMITS : EDGE_R2_IMAGE_LIMITS
}

interface ImageMetadata {
  mediaType: ImageMediaType
  width: number
  height: number
}

export interface EdgeR2AttachmentStoreConfig {
  bucket: R2Bucket
  images?: ImagesBinding
  /** The workspace VFS verbatim files are kept in; without it files are refused, as upstream's default does. */
  files?: EdgeFileAttachments.OpenAttachmentFiles
}

interface AttachmentDigest {
  hex: string
  bytes: ArrayBuffer
}

abstract class EdgeImageAttachmentStore extends AttachmentStore {
  abstract override readonly imageLimits: ImageAttachmentLimits
  protected images?: ImagesBinding
  protected files?: EdgeFileAttachments.OpenAttachmentFiles

  // Images stay in R2 or Durable Object rows; verbatim files live in the
  // workspace VFS, where the model's file tools can read them by path.
  override saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    return this.saveFileStream({
      data: (async function* () { yield input.data })(),
      ...input.name === undefined ? {} : { name: input.name },
    })
  }

  override saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    if (this.files === undefined) return super.saveFileStream(input)
    return EdgeFileAttachments.saveFileStream(this.files, input)
  }

  override readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    if (this.files === undefined) return super.readFileStream(ref, signal)
    return EdgeFileAttachments.readFileStream(this.files, ref, signal)
  }

  override fileHostPath(ref: FileAttachmentRef): string | undefined {
    return this.files === undefined ? undefined : EdgeFileAttachments.storedFilePath(ref)
  }

  override async validateImage(input: SaveImageAttachment): Promise<void> {
    if (this.images === undefined) await inspectImage(input.data, input.mediaType, this.imageLimits, true)
    else admitHeader(input.data, input.mediaType, this.imageLimits)
  }

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const prepared = this.images === undefined
      ? { data: input.data, metadata: await inspectImage(input.data, input.mediaType, this.imageLimits, true) }
      : await this.normalizeImage(input, this.images)
    const { data, metadata } = prepared
    const digest = await sha256(data)
    try {
      await this.writeBytes(digest, data, metadata)
    } catch (error) {
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError(
        'Unable to persist image attachment.',
        'ATTACHMENT_WRITE_FAILED',
        { cause: error },
      )
    }
    const name = displayName(input.name)
    return {
      attachmentId: AttachmentId(`sha256:${digest.hex}`),
      ...metadata,
      bytes: data.byteLength,
      ...name === undefined ? {} : { name },
      ...'originalDimensions' in prepared && prepared.originalDimensions !== undefined
        ? { originalDimensions: prepared.originalDimensions }
        : {},
    }
  }

  /**
   * Store an image as upstream's normalization would: as submitted when it
   * already fits, else transformed by Images. When Images fails (its monthly
   * free allowance spent, for one), an image inside the limits a store
   * without Images admits is kept as submitted, as before; any other is
   * refused, saying why, rather than decoded in the Worker.
   */
  private async normalizeImage(input: SaveImageAttachment, images: ImagesBinding): Promise<{
    data: Uint8Array
    metadata: ImageMetadata
    originalDimensions?: { width: number, height: number }
  }> {
    const header = admitHeader(input.data, input.mediaType, this.imageLimits)
    if (passesThrough(header, input.data.byteLength)) return { data: input.data, metadata: metadataOf(header) }
    let normalized: Awaited<ReturnType<typeof normalizeWithImages>>
    try {
      normalized = await normalizeWithImages(images, input.data, header)
    } catch (error) {
      try {
        return { data: input.data, metadata: await inspectImage(input.data, input.mediaType, EDGE_R2_IMAGE_LIMITS, true) }
      } catch {
        throw new AttachmentError(
          `Image optimization is unavailable (${messageOf(error)}), and without it only PNG or JPEG images up to `
          + `${String(EDGE_R2_IMAGE_LIMITS.maxImageDimension)} px per side and 3.5 MiB are accepted.`,
          'ATTACHMENT_WRITE_FAILED',
          { cause: error },
        )
      }
    }
    // Images in production applies EXIF rotation (its local development mode
    // does not), so a quarter turn swaps the sides; the output's own shape says
    // which happened.
    const source = { width: header.width, height: header.height }
    const swapped = { width: header.height, height: header.width }
    const original = header.orientation >= 5 && sameShape(normalized.header, swapped) && !sameShape(normalized.header, source)
      ? swapped
      : source
    const resized = original.width !== normalized.header.width || original.height !== normalized.header.height
    return {
      data: normalized.data,
      metadata: metadataOf(normalized.header),
      ...resized ? { originalDimensions: original } : {},
    }
  }

  override async readImage(
    ref: ImageAttachmentRef,
    signal?: AbortSignal,
  ): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const digest = referenceDigest(ref)
    let data: Uint8Array | undefined
    try {
      data = await this.readBytes(digest, signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError(
        'Unable to read image attachment.',
        'ATTACHMENT_READ_FAILED',
        { cause: error },
      )
    }
    if (data === undefined) {
      throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    signal?.throwIfAborted()
    const actualDigest = await sha256(data)
    if (actualDigest.hex !== digest) {
      throw new AttachmentError(
        'Stored attachment failed integrity verification.',
        'ATTACHMENT_CORRUPT',
      )
    }
    const metadata = await inspectImage(data, ref.mediaType, this.imageLimits, false)
    if (data.byteLength !== ref.bytes
      || metadata.width !== ref.width
      || metadata.height !== ref.height) {
      throw new AttachmentError(
        'Stored attachment metadata does not match its reference.',
        'ATTACHMENT_CORRUPT',
      )
    }
    signal?.throwIfAborted()
    return { ref, data }
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ) {
    const stored = await this.readImage(ref, signal)
    const descriptor = `${ref.attachmentId}:${String(target.width)}x${String(target.height)}:${String(target.maxBytes)}`
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(descriptor))
    const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
    const variantId = ImageVariantId(`sha256:${hex}`)

    const base = {
      variantId, attachment: ref, mediaType: ref.mediaType,
      width: ref.width, height: ref.height,
      depth: 'uchar' as const, space: 'srgb' as const,
      hasAlpha: ref.mediaType === 'image/png' || ref.mediaType === 'image/webp',
    }

    if (this.images !== undefined) {
      try {
        signal?.throwIfAborted()
        const result = await this.images
          .input(new Blob([stored.data as Uint8Array<ArrayBuffer>]).stream())
          .transform({ width: target.width, height: target.height, fit: 'scale-down' })
          .output({ format: ref.mediaType })
        signal?.throwIfAborted()
        const resp = await responseBytes(result)
        signal?.throwIfAborted()
        const transformed = new Uint8Array(resp)
        if (transformed.byteLength <= target.maxBytes) {
          return { ...base, data: transformed, bytes: transformed.byteLength }
        }
      } catch {
        if (signal?.aborted) throw signal.reason
      }
    }

    return { ...base, data: stored.data, bytes: stored.data.byteLength }
  }

  protected abstract writeBytes(
    digest: AttachmentDigest,
    data: Uint8Array,
    metadata: ImageMetadata,
  ): Promise<void>

  protected abstract readBytes(
    digest: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined>
}

/** Owner-private, content-addressed image storage backed by one R2 binding. */
export class EdgeR2AttachmentStore extends EdgeImageAttachmentStore {
  readonly imageLimits: ImageAttachmentLimits

  private readonly bucket: R2Bucket

  constructor(ctx: Context, config: EdgeR2AttachmentStoreConfig) {
    super(ctx)
    this.bucket = config.bucket
    if (config.images !== undefined) this.images = config.images
    this.imageLimits = edgeImageLimits(this.images !== undefined)
    if (config.files !== undefined) this.files = config.files
  }

  protected override async writeBytes(
    digest: AttachmentDigest,
    data: Uint8Array,
    metadata: ImageMetadata,
  ): Promise<void> {
    await this.bucket.put(objectKey(digest.hex), data, {
      httpMetadata: { contentType: metadata.mediaType },
      customMetadata: { sha256: digest.hex },
      sha256: digest.bytes,
    })
  }

  protected override async readBytes(
    digest: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    signal?.throwIfAborted()
    const object = await this.bucket.get(objectKey(digest))
    if (object === null) return undefined
    return await object.bytes()
  }
}

interface EdgeDoAttachmentStoreConfig {
  storage: DurableObjectStorage
  maxStoredBytes?: number
  images?: ImagesBinding
  files?: EdgeFileAttachments.OpenAttachmentFiles
}

interface AttachmentObjectRow extends Record<string, SqlStorageValue> {
  bytes: number
  chunks: number
}

interface AttachmentChunkRow extends Record<string, SqlStorageValue> {
  chunk_index: number
  data: ArrayBuffer
}

interface AttachmentStateRow extends Record<string, SqlStorageValue> {
  schema_version: number
  stored_bytes: number
  backend: string
}

export type EdgeAttachmentStorage = 'private-r2' | 'temporary-do'

/** Pin the backend on first use so claiming or upgrading cannot strand prior refs. */
export function resolveEdgeAttachmentStorage(
  storage: DurableObjectStorage,
  bucket: R2Bucket | undefined,
): EdgeAttachmentStorage {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_edge_attachment_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
    backend TEXT NOT NULL CHECK (backend IN ('private-r2', 'temporary-do'))
  ) STRICT`)
  return storage.transactionSync(() => {
    const state = storage.sql.exec<AttachmentStateRow>(
      `SELECT schema_version, stored_bytes, backend FROM dsh_edge_attachment_state
       WHERE singleton = 1`,
    ).toArray()[0]
    if (state !== undefined && state.schema_version !== DO_ATTACHMENT_SCHEMA_VERSION) {
      throw new Error(
        `dsh-edge attachment schema ${state.schema_version} is incompatible with ${DO_ATTACHMENT_SCHEMA_VERSION}`,
      )
    }
    if (state !== undefined) {
      if (state.backend === 'private-r2' && bucket === undefined) {
        throw new Error('The pinned private R2 attachment binding is unavailable.')
      }
      if (state.backend !== 'private-r2' && state.backend !== 'temporary-do') {
        throw new Error('The pinned attachment backend is invalid.')
      }
      return state.backend
    }
    const backend = bucket === undefined ? 'temporary-do' : 'private-r2'
    storage.sql.exec(
      `INSERT INTO dsh_edge_attachment_state
        (singleton, schema_version, stored_bytes, backend) VALUES (1, ?, 0, ?)`,
      DO_ATTACHMENT_SCHEMA_VERSION,
      backend,
    )
    return backend
  })
}

/** Bounded fallback for temporary installs that cannot provision an R2 binding. */
export class EdgeDoAttachmentStore extends EdgeImageAttachmentStore {
  readonly imageLimits: ImageAttachmentLimits

  private readonly storage: DurableObjectStorage
  private readonly maxStoredBytes: number

  constructor(ctx: Context, config: EdgeDoAttachmentStoreConfig) {
    super(ctx)
    this.storage = config.storage
    this.maxStoredBytes = config.maxStoredBytes ?? EDGE_DO_ATTACHMENT_MAX_STORED_BYTES
    if (config.images !== undefined) this.images = config.images
    this.imageLimits = edgeImageLimits(this.images !== undefined)
    if (config.files !== undefined) this.files = config.files
    if (!Number.isSafeInteger(this.maxStoredBytes) || this.maxStoredBytes <= 0) {
      throw new Error('Temporary attachment storage limit must be a positive integer.')
    }
    this.initialize()
  }

  override async saveImages(
    inputs: readonly SaveImageAttachment[],
  ): Promise<readonly ImageAttachmentRef[]> {
    const pending: Array<{ digest: AttachmentDigest, data: Uint8Array }> = []
    const collector = Object.create(this) as EdgeDoAttachmentStore
    collector.writeBytes = (digest, data) => {
      pending.push({ digest, data })
      return Promise.resolve()
    }
    const refs = await AttachmentStore.prototype.saveImages.call(collector, inputs)
    try {
      this.writeBatch(pending)
    } catch (error) {
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError(
        'Unable to persist image attachments.',
        'ATTACHMENT_WRITE_FAILED',
        { cause: error },
      )
    }
    return refs
  }

  protected override writeBytes(
    digest: AttachmentDigest,
    data: Uint8Array,
  ): Promise<void> {
    this.writeBatch([{ digest, data }])
    return Promise.resolve()
  }

  private writeBatch(
    pending: readonly { digest: AttachmentDigest, data: Uint8Array }[],
  ): void {
    this.storage.transactionSync(() => {
      const unique = new Map<string, { digest: AttachmentDigest, data: Uint8Array }>()
      for (const item of pending) {
        const duplicate = unique.get(item.digest.hex)
        if (duplicate !== undefined && duplicate.data.byteLength !== item.data.byteLength) {
          throw new AttachmentError(
            'Attachment batch has conflicting content identity metadata.',
            'ATTACHMENT_CORRUPT',
          )
        }
        unique.set(item.digest.hex, item)
      }
      const additions = [...unique.values()].filter(({ digest, data }) => {
        const existing = this.objectRow(digest.hex)
        if (existing !== undefined && existing.bytes !== data.byteLength) {
          throw new AttachmentError(
            'Stored attachment identity has conflicting metadata.',
            'ATTACHMENT_CORRUPT',
          )
        }
        return existing === undefined
      })
      const state = this.stateRow()
      const addedBytes = additions.reduce((sum, item) => sum + item.data.byteLength, 0)
      if (state.stored_bytes + addedBytes > this.maxStoredBytes) {
        throw new AttachmentError(
          'Temporary attachment storage is full. Install a permanent instance with private R2 storage.',
          'ATTACHMENT_WRITE_FAILED',
        )
      }
      for (const { digest, data } of additions) {
        const chunks = Math.ceil(data.byteLength / DO_ATTACHMENT_CHUNK_BYTES)
        this.storage.sql.exec(
          `INSERT INTO dsh_edge_attachment_objects (digest, bytes, chunks, created_at)
           VALUES (?, ?, ?, ?)`,
          digest.hex,
          data.byteLength,
          chunks,
          Date.now(),
        )
        for (let index = 0; index < chunks; index += 1) {
          const start = index * DO_ATTACHMENT_CHUNK_BYTES
          const chunk = ownedArrayBuffer(data.subarray(
            start,
            Math.min(start + DO_ATTACHMENT_CHUNK_BYTES, data.byteLength),
          ))
          this.storage.sql.exec(
            `INSERT INTO dsh_edge_attachment_chunks (digest, chunk_index, data)
             VALUES (?, ?, ?)`,
            digest.hex,
            index,
            chunk,
          )
        }
      }
      this.storage.sql.exec(
        `UPDATE dsh_edge_attachment_state
         SET stored_bytes = stored_bytes + ? WHERE singleton = 1`,
        addedBytes,
      )
    })
  }

  protected override readBytes(
    digest: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    signal?.throwIfAborted()
    const object = this.objectRow(digest)
    if (object === undefined) return Promise.resolve(undefined)
    if (object.bytes <= 0 || object.bytes > this.maxStoredBytes
      || object.chunks !== Math.ceil(object.bytes / DO_ATTACHMENT_CHUNK_BYTES)) {
      throw new AttachmentError('Stored attachment metadata is invalid.', 'ATTACHMENT_CORRUPT')
    }
    const rows = this.storage.sql.exec<AttachmentChunkRow>(
      `SELECT chunk_index, data FROM dsh_edge_attachment_chunks
       WHERE digest = ? ORDER BY chunk_index ASC`,
      digest,
    ).toArray()
    if (rows.length !== object.chunks) {
      throw new AttachmentError('Stored attachment chunks are incomplete.', 'ATTACHMENT_CORRUPT')
    }
    const data = new Uint8Array(object.bytes)
    let offset = 0
    for (const [index, row] of rows.entries()) {
      signal?.throwIfAborted()
      if (row.chunk_index !== index) {
        throw new AttachmentError('Stored attachment chunks are invalid.', 'ATTACHMENT_CORRUPT')
      }
      const chunk = new Uint8Array(row.data)
      const expected = Math.min(DO_ATTACHMENT_CHUNK_BYTES, object.bytes - offset)
      if (chunk.byteLength !== expected) {
        throw new AttachmentError('Stored attachment chunk size is invalid.', 'ATTACHMENT_CORRUPT')
      }
      data.set(chunk, offset)
      offset += chunk.byteLength
    }
    return Promise.resolve(data)
  }

  private initialize(): void {
    this.storage.sql.exec('PRAGMA foreign_keys = ON')
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_edge_attachment_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
        backend TEXT NOT NULL CHECK (backend IN ('private-r2', 'temporary-do'))
      ) STRICT`)
      const state = this.storage.sql.exec<AttachmentStateRow>(
        `SELECT schema_version, stored_bytes, backend FROM dsh_edge_attachment_state
         WHERE singleton = 1`,
      ).toArray()[0]
      if (state !== undefined && state.schema_version !== DO_ATTACHMENT_SCHEMA_VERSION) {
        throw new Error(
          `dsh-edge attachment schema ${state.schema_version} is incompatible with ${DO_ATTACHMENT_SCHEMA_VERSION}`,
        )
      }
      if (state === undefined || state.backend !== 'temporary-do') {
        throw new Error('The temporary attachment backend is not pinned for this instance.')
      }
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_edge_attachment_objects (
        digest TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL CHECK (bytes > 0),
        chunks INTEGER NOT NULL CHECK (chunks > 0),
        created_at INTEGER NOT NULL
      ) STRICT`)
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dsh_edge_attachment_chunks (
        digest TEXT NOT NULL REFERENCES dsh_edge_attachment_objects(digest) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
        data BLOB NOT NULL,
        PRIMARY KEY (digest, chunk_index)
      ) STRICT`)
    })
  }

  private objectRow(digest: string): AttachmentObjectRow | undefined {
    return this.storage.sql.exec<AttachmentObjectRow>(
      `SELECT bytes, chunks FROM dsh_edge_attachment_objects WHERE digest = ?`,
      digest,
    ).toArray()[0]
  }

  private stateRow(): AttachmentStateRow {
    const state = this.storage.sql.exec<AttachmentStateRow>(
      `SELECT schema_version, stored_bytes, backend FROM dsh_edge_attachment_state
       WHERE singleton = 1`,
    ).toArray()[0]
    if (state === undefined || state.schema_version !== DO_ATTACHMENT_SCHEMA_VERSION
      || state.backend !== 'temporary-do') {
      throw new Error('dsh-edge attachment storage state is unavailable')
    }
    return state
  }
}

/**
 * Admit one image from its header alone (the Images path): its type, declared
 * type, and the byte, pixel, and side limits. Nothing is decoded.
 */
function admitHeader(data: Uint8Array, declaredMediaType: ImageMediaType, limits: ImageAttachmentLimits): ImageHeader {
  if (data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  if (data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  let header: ImageHeader
  try {
    header = readImageHeader(data)
  } catch (error) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
  if (!limits.mediaTypes.includes(header.mediaType)) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
  }
  if (header.mediaType !== declaredMediaType) {
    throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
  }
  enforceMetadataLimits(header, limits)
  return header
}

/**
 * Check one image against limits, decoding its pixels when asked (a store
 * without Images, which admits only PNG and JPEG small enough to decode).
 */
async function inspectImage(
  data: Uint8Array,
  declaredMediaType: ImageMediaType,
  limits: ImageAttachmentLimits,
  decodePixels: boolean,
): Promise<ImageMetadata> {
  const header = admitHeader(data, declaredMediaType, limits)
  if (decodePixels) {
    try {
      const decoded = header.mediaType === 'image/png'
        ? decodePng(data, { checkCrc: true })
        : header.mediaType === 'image/jpeg'
          ? decodeJpeg(data, {
              useTArray: true,
              tolerantDecoding: false,
              maxResolutionInMP: limits.maxImagePixels / 1_000_000,
              maxMemoryUsageInMB: 64,
            })
          : undefined
      if (decoded === undefined) throw new Error(`${header.mediaType} is not decoded in the Worker`)
      if (decoded.width !== header.width || decoded.height !== header.height) {
        throw new Error('decoder metadata mismatch')
      }
    } catch (error) {
      throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
    }
  }
  return metadataOf(header)
}

/** Whether two sizes have the same aspect ratio, within the rounding of a downscale. */
function sameShape(left: { width: number, height: number }, right: { width: number, height: number }): boolean {
  return Math.abs(left.width / left.height - right.width / right.height) <= 0.01 * (right.width / right.height)
}

function metadataOf(header: ImageHeader): ImageMetadata {
  return { mediaType: header.mediaType, width: header.width, height: header.height }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function enforceMetadataLimits(
  metadata: ImageMetadata,
  limits: ImageAttachmentLimits,
): void {
  const pixels = metadata.width * metadata.height
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxImagePixels) {
    throw new AttachmentError(
      'Image exceeds the configured decoded-pixel limit.',
      'IMAGE_TOO_MANY_PIXELS',
    )
  }
  if (Math.max(metadata.width, metadata.height) > limits.maxImageDimension) {
    throw new AttachmentError(
      'Image exceeds the configured per-side pixel limit.',
      'IMAGE_DIMENSION_TOO_LARGE',
    )
  }
}

function referenceDigest(ref: ImageAttachmentRef): string {
  const match = ATTACHMENT_ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) {
    throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  }
  return match[1]
}

function objectKey(digest: string): string {
  return `${R2_OBJECT_PREFIX}/${digest.slice(0, 2)}/${digest}`
}

async function sha256(data: Uint8Array): Promise<AttachmentDigest> {
  const input = new Uint8Array(data.byteLength)
  input.set(data)
  const bytes = await crypto.subtle.digest('SHA-256', input.buffer)
  return {
    bytes,
    hex: [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join(''),
  }
}

function ownedArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy.buffer
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/\p{Cc}/gu, '').trim().slice(0, 255)
  return clean.length === 0 ? undefined : clean
}
