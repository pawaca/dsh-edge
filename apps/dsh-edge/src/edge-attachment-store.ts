/** Cloudflare R2 implementation of the upstream durable attachment seam. */

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

interface ImageMetadata {
  mediaType: ImageMediaType
  width: number
  height: number
}

export interface EdgeR2AttachmentStoreConfig {
  bucket: R2Bucket
}

/** Owner-private, content-addressed image storage backed by one R2 binding. */
export class EdgeR2AttachmentStore extends AttachmentStore {
  readonly imageLimits = EDGE_R2_IMAGE_LIMITS

  private readonly bucket: R2Bucket

  constructor(ctx: Context, config: EdgeR2AttachmentStoreConfig) {
    super(ctx)
    this.bucket = config.bucket
  }

  override async validateImage(input: SaveImageAttachment): Promise<void> {
    await inspectImage(input.data, input.mediaType, this.imageLimits, true)
  }

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const metadata = await inspectImage(input.data, input.mediaType, this.imageLimits, true)
    const digest = await sha256(input.data)
    try {
      await this.bucket.put(objectKey(digest.hex), input.data, {
        httpMetadata: { contentType: metadata.mediaType },
        customMetadata: { sha256: digest.hex },
        sha256: digest.bytes,
      })
    } catch (error) {
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
    let object: R2ObjectBody | null
    try {
      object = await this.bucket.get(objectKey(digest))
    } catch (error) {
      signal?.throwIfAborted()
      throw new AttachmentError(
        'Unable to read image attachment.',
        'ATTACHMENT_READ_FAILED',
        { cause: error },
      )
    }
    if (object === null) {
      throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    let data: Uint8Array
    try {
      data = await object.bytes()
    } catch (error) {
      signal?.throwIfAborted()
      throw new AttachmentError(
        'Unable to read image attachment.',
        'ATTACHMENT_READ_FAILED',
        { cause: error },
      )
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

async function sha256(data: Uint8Array): Promise<{ hex: string; bytes: ArrayBuffer }> {
  const input = new Uint8Array(data.byteLength)
  input.set(data)
  const bytes = await crypto.subtle.digest('SHA-256', input.buffer)
  return {
    bytes,
    hex: [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join(''),
  }
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
