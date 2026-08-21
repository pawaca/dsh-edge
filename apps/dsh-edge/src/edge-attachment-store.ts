/** Cloudflare implementations of the upstream durable attachment seam. */

import {
  AttachmentError,
  AttachmentId,
  AttachmentStore,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageMediaType,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { decode as decodePng } from 'fast-png'
import { decode as decodeJpeg } from 'jpeg-js'

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
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)

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

interface ImageMetadata {
  mediaType: ImageMediaType
  width: number
  height: number
}

export interface EdgeR2AttachmentStoreConfig {
  bucket: R2Bucket
}

interface AttachmentDigest {
  hex: string
  bytes: ArrayBuffer
}

abstract class EdgeImageAttachmentStore extends AttachmentStore {
  abstract override readonly imageLimits: ImageAttachmentLimits

  override async validateImage(input: SaveImageAttachment): Promise<void> {
    await inspectImage(input.data, input.mediaType, this.imageLimits, true)
  }

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const metadata = await inspectImage(input.data, input.mediaType, this.imageLimits, true)
    const digest = await sha256(input.data)
    try {
      await this.writeBytes(digest, input.data, metadata)
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
      bytes: input.data.byteLength,
      ...name === undefined ? {} : { name },
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
  readonly imageLimits = EDGE_R2_IMAGE_LIMITS

  private readonly bucket: R2Bucket

  constructor(ctx: Context, config: EdgeR2AttachmentStoreConfig) {
    super(ctx)
    this.bucket = config.bucket
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
  readonly imageLimits = EDGE_DO_IMAGE_LIMITS

  private readonly storage: DurableObjectStorage
  private readonly maxStoredBytes: number

  constructor(ctx: Context, config: EdgeDoAttachmentStoreConfig) {
    super(ctx)
    this.storage = config.storage
    this.maxStoredBytes = config.maxStoredBytes ?? EDGE_DO_ATTACHMENT_MAX_STORED_BYTES
    if (!Number.isSafeInteger(this.maxStoredBytes) || this.maxStoredBytes <= 0) {
      throw new Error('Temporary attachment storage limit must be a positive integer.')
    }
    this.initialize()
  }

  protected override writeBytes(
    digest: AttachmentDigest,
    data: Uint8Array,
  ): Promise<void> {
    this.storage.transactionSync(() => {
      const existing = this.objectRow(digest.hex)
      if (existing !== undefined) {
        if (existing.bytes !== data.byteLength) {
          throw new AttachmentError(
            'Stored attachment identity has conflicting metadata.',
            'ATTACHMENT_CORRUPT',
          )
        }
        return
      }
      const state = this.stateRow()
      if (state.stored_bytes + data.byteLength > this.maxStoredBytes) {
        throw new AttachmentError(
          'Temporary attachment storage is full. Install a permanent instance with private R2 storage.',
          'ATTACHMENT_WRITE_FAILED',
        )
      }
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
      this.storage.sql.exec(
        `UPDATE dsh_edge_attachment_state
         SET stored_bytes = stored_bytes + ? WHERE singleton = 1`,
        data.byteLength,
      )
    })
    return Promise.resolve()
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

async function inspectImage(
  data: Uint8Array,
  declaredMediaType: ImageMediaType,
  limits: ImageAttachmentLimits,
  decodePixels: boolean,
): Promise<ImageMetadata> {
  if (data.byteLength === 0) {
    throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  }
  if (data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  let metadata: ImageMetadata
  try {
    if (hasPrefix(data, PNG_SIGNATURE)) {
      metadata = pngMetadata(data)
      enforceMetadataLimits(metadata, limits)
      if (decodePixels) {
        const decoded = decodePng(data, { checkCrc: true })
        if (decoded.width !== metadata.width || decoded.height !== metadata.height) {
          throw new Error('PNG decoder metadata mismatch')
        }
      }
    } else if (data[0] === 0xff && data[1] === 0xd8) {
      metadata = jpegMetadata(data)
      enforceMetadataLimits(metadata, limits)
      if (decodePixels) {
        const decoded = decodeJpeg(data, {
          useTArray: true,
          tolerantDecoding: false,
          maxResolutionInMP: limits.maxImagePixels / 1_000_000,
          maxMemoryUsageInMB: 64,
        })
        if (decoded.width !== metadata.width || decoded.height !== metadata.height) {
          throw new Error('JPEG decoder metadata mismatch')
        }
      }
    } else {
      throw new Error('unsupported raster signature')
    }
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError(
      'Unsupported or malformed image data.',
      'INVALID_IMAGE',
      { cause: error },
    )
  }
  if (metadata.mediaType !== declaredMediaType) {
    throw new AttachmentError(
      'Declared image type does not match its bytes.',
      'IMAGE_TYPE_MISMATCH',
    )
  }
  return metadata
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

function pngMetadata(data: Uint8Array): ImageMetadata {
  if (data.byteLength < 24
    || readUint32(data, 8) !== 13
    || ascii(data, 12, 16) !== 'IHDR') {
    throw new Error('invalid PNG header')
  }
  const width = readUint32(data, 16)
  const height = readUint32(data, 20)
  if (width === 0 || height === 0) throw new Error('invalid PNG dimensions')
  return { mediaType: 'image/png', width, height }
}

function jpegMetadata(data: Uint8Array): ImageMetadata {
  let offset = 2
  while (offset < data.byteLength) {
    while (data[offset] === 0xff) offset += 1
    const marker = data[offset]
    offset += 1
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > data.byteLength) throw new Error('truncated JPEG segment')
    const length = readUint16(data, offset)
    if (length < 2 || offset + length > data.byteLength) throw new Error('invalid JPEG segment')
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) throw new Error('invalid JPEG frame')
      const height = readUint16(data, offset + 3)
      const width = readUint16(data, offset + 5)
      if (width === 0 || height === 0) throw new Error('invalid JPEG dimensions')
      return { mediaType: 'image/jpeg', width, height }
    }
    offset += length
  }
  throw new Error('JPEG frame header is missing')
}

function isJpegStartOfFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf)
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

function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  return data.byteLength >= prefix.byteLength
    && prefix.every((value, index) => data[index] === value)
}

function readUint16(data: Uint8Array, offset: number): number {
  const high = data[offset]
  const low = data[offset + 1]
  if (high === undefined || low === undefined) throw new Error('truncated integer')
  return high * 0x100 + low
}

function readUint32(data: Uint8Array, offset: number): number {
  const a = data[offset]
  const b = data[offset + 1]
  const c = data[offset + 2]
  const d = data[offset + 3]
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error('truncated integer')
  }
  return ((a * 0x100 + b) * 0x100 + c) * 0x100 + d
}

function ascii(data: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...data.subarray(start, end))
}
