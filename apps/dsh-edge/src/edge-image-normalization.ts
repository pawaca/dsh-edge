/**
 * Image normalization through the Cloudflare Images binding, as upstream
 * dsh-attachment-local normalizes with sharp.
 *
 * The Worker never decodes pixels here: an 8192 x 8192 RGBA bitmap alone
 * would be twice the isolate's memory. Each format's header gives its media
 * type and size, and a JPEG's EXIF block its orientation; Images does every
 * transform. Only an image that needs it is transformed (over the pixel
 * budget or byte target, WebP or GIF, or a rotated JPEG), so a clean small
 * PNG or JPEG costs no Images transformation. Images bills a source and
 * transform once a month however many qualities are tried, since format and
 * quality do not make a transformation unique.
 */

import { AttachmentError, type ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** The Images binding calls normalization and request variants use. */
export interface ImagesBinding {
  input(data: ReadableStream<Uint8Array>): {
    transform(options: { width?: number, height?: number, fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad' }): {
      output(options: { format: string, quality?: number, anim?: boolean }): Promise<unknown>
    }
  }
}

/** What a header tells about one encoded image, without decoding it. */
export interface ImageHeader {
  mediaType: ImageMediaType
  width: number
  height: number
  /** Whether the format may carry transparency (PNG alpha or tRNS, WebP alpha, any GIF). */
  hasAlpha: boolean
  /** JPEG EXIF orientation, 1 when absent. */
  orientation: number
}

/** Upstream's normalized-image policy: total-pixel budget, long-edge cap, and byte target. */
export const NORMALIZED_IMAGE_POLICY = Object.freeze({
  maxPixels: 2048 * 2048,
  maxDimension: 8192,
  maxBytes: 4 * 1024 * 1024,
})

/** Upstream's encoding ladder, highest quality first. */
const QUALITIES = [85, 75, 60] as const

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)

/** Read the header of a PNG, JPEG, GIF, or WebP image; throws on anything else or a malformed header. */
export function readImageHeader(data: Uint8Array): ImageHeader {
  if (hasPrefix(data, PNG_SIGNATURE)) return pngHeader(data)
  if (data[0] === 0xff && data[1] === 0xd8) return jpegHeader(data)
  if (ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a') return gifHeader(data)
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return webpHeader(data)
  throw new Error('unsupported raster signature')
}

/** Whether an image can be stored as submitted: upstream's pass-through rule, from headers. */
export function passesThrough(header: ImageHeader, bytes: number): boolean {
  return (header.mediaType === 'image/png' || header.mediaType === 'image/jpeg')
    && header.orientation === 1
    && bytes <= NORMALIZED_IMAGE_POLICY.maxBytes
    && header.width * header.height <= NORMALIZED_IMAGE_POLICY.maxPixels
    && Math.max(header.width, header.height) <= NORMALIZED_IMAGE_POLICY.maxDimension
}

/** Dimensions under the pixel budget, then the long-edge cap, keeping the aspect ratio (upstream's rule). */
export function normalizedDimensions(width: number, height: number): { width: number, height: number } {
  const { maxPixels, maxDimension } = NORMALIZED_IMAGE_POLICY
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)), maxDimension / Math.max(width, height))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

/**
 * Transform one image into the normalized form: oriented (Images applies EXIF
 * rotation), first frame only, inside the pixel budget, WebP when it may hold
 * transparency and JPEG otherwise, at the first ladder quality inside the byte
 * target, else the smallest. The result's size is read from its own header.
 */
export async function normalizeWithImages(
  images: ImagesBinding,
  data: Uint8Array,
  header: ImageHeader,
  signal?: AbortSignal,
): Promise<{ data: Uint8Array, header: ImageHeader }> {
  const target = normalizedDimensions(header.width, header.height)
  const format = header.hasAlpha ? 'image/webp' : 'image/jpeg'
  let smallest: Uint8Array | undefined
  for (const quality of QUALITIES) {
    signal?.throwIfAborted()
    const result = await images
      .input(new Blob([data as Uint8Array<ArrayBuffer>]).stream())
      .transform({ width: target.width, height: target.height, fit: 'scale-down' })
      .output({ format, quality, anim: false })
    const encoded = new Uint8Array(await responseBytes(result))
    if (smallest === undefined || encoded.byteLength < smallest.byteLength) smallest = encoded
    if (encoded.byteLength <= NORMALIZED_IMAGE_POLICY.maxBytes) break
  }
  const output = smallest!
  const produced = readImageHeader(output)
  if (produced.mediaType !== format) throw new Error(`Images produced ${produced.mediaType}, not ${format}`)
  return { data: output, header: produced }
}

/** The bytes of a binding result: a transformation result, a Response, or a body. */
export async function responseBytes(result: unknown): Promise<ArrayBuffer> {
  if (result instanceof Response) return await result.arrayBuffer()
  const value = result as { response?: () => Response, arrayBuffer?: () => Promise<ArrayBuffer> }
  if (typeof value.response === 'function') return await value.response().arrayBuffer()
  if (typeof value.arrayBuffer === 'function') return await value.arrayBuffer()
  throw new AttachmentError('The Images binding returned no image.', 'ATTACHMENT_WRITE_FAILED')
}

function pngHeader(data: Uint8Array): ImageHeader {
  if (data.byteLength < 33 || readUint32(data, 8) !== 13 || ascii(data, 12, 16) !== 'IHDR') {
    throw new Error('invalid PNG header')
  }
  const width = readUint32(data, 16)
  const height = readUint32(data, 20)
  if (width === 0 || height === 0) throw new Error('invalid PNG dimensions')
  const colorType = data[25]!
  // Colour types 4 and 6 carry alpha; a tRNS chunk before the image data adds transparency to the others.
  let hasAlpha = colorType === 4 || colorType === 6
  for (let offset = 33; !hasAlpha && offset + 8 <= data.byteLength;) {
    const length = readUint32(data, offset)
    const type = ascii(data, offset + 4, offset + 8)
    if (type === 'IDAT' || type === 'IEND') break
    if (type === 'tRNS') hasAlpha = true
    offset += 12 + length
  }
  return { mediaType: 'image/png', width, height, hasAlpha, orientation: 1 }
}

function jpegHeader(data: Uint8Array): ImageHeader {
  let orientation = 1
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
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(data.subarray(offset + 2, offset + length))
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) throw new Error('invalid JPEG frame')
      const height = readUint16(data, offset + 3)
      const width = readUint16(data, offset + 5)
      if (width === 0 || height === 0) throw new Error('invalid JPEG dimensions')
      return { mediaType: 'image/jpeg', width, height, hasAlpha: false, orientation }
    }
    offset += length
  }
  throw new Error('JPEG frame header is missing')
}

/** The orientation tag (0x0112) of an APP1 Exif segment's first IFD; 1 when absent or unreadable. */
export function exifOrientation(segment: Uint8Array): number {
  if (ascii(segment, 0, 6) !== 'Exif\0\0') return 1
  const tiff = segment.subarray(6)
  const order = ascii(tiff, 0, 2)
  if (order !== 'II' && order !== 'MM') return 1
  const little = order === 'II'
  const u16 = (at: number) => at + 2 > tiff.byteLength ? undefined : little ? tiff[at]! + tiff[at + 1]! * 0x100 : tiff[at]! * 0x100 + tiff[at + 1]!
  const u32 = (at: number) => {
    const low = u16(little ? at : at + 2)
    const high = u16(little ? at + 2 : at)
    return low === undefined || high === undefined ? undefined : high * 0x10000 + low
  }
  const ifd = u32(4)
  const count = ifd === undefined ? undefined : u16(ifd)
  if (ifd === undefined || count === undefined) return 1
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12
    if (u16(entry) !== 0x0112) continue
    const value = u16(entry + 8)
    return value !== undefined && value >= 1 && value <= 8 ? value : 1
  }
  return 1
}

function gifHeader(data: Uint8Array): ImageHeader {
  if (data.byteLength < 10) throw new Error('invalid GIF header')
  const width = data[6]! + data[7]! * 0x100
  const height = data[8]! + data[9]! * 0x100
  if (width === 0 || height === 0) throw new Error('invalid GIF dimensions')
  return { mediaType: 'image/gif', width, height, hasAlpha: true, orientation: 1 }
}

function webpHeader(data: Uint8Array): ImageHeader {
  const chunk = ascii(data, 12, 16)
  let width: number
  let height: number
  let hasAlpha: boolean
  if (chunk === 'VP8X') {
    if (data.byteLength < 30) throw new Error('invalid WebP header')
    hasAlpha = (data[20]! & 0x10) !== 0
    width = 1 + data[24]! + data[25]! * 0x100 + data[26]! * 0x10000
    height = 1 + data[27]! + data[28]! * 0x100 + data[29]! * 0x10000
  } else if (chunk === 'VP8L') {
    if (data.byteLength < 25 || data[20] !== 0x2f) throw new Error('invalid WebP header')
    const bits = data[21]! + data[22]! * 0x100 + data[23]! * 0x10000 + data[24]! * 0x1000000
    width = 1 + (bits & 0x3fff)
    height = 1 + ((bits >>> 14) & 0x3fff)
    hasAlpha = ((bits >>> 28) & 1) === 1
  } else if (chunk === 'VP8 ') {
    if (data.byteLength < 30 || data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) throw new Error('invalid WebP header')
    width = (data[26]! + data[27]! * 0x100) & 0x3fff
    height = (data[28]! + data[29]! * 0x100) & 0x3fff
    hasAlpha = false
  } else {
    throw new Error('invalid WebP header')
  }
  if (width === 0 || height === 0) throw new Error('invalid WebP dimensions')
  return { mediaType: 'image/webp', width, height, hasAlpha, orientation: 1 }
}

function isJpegStartOfFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf)
}

function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  return data.byteLength >= prefix.byteLength && prefix.every((value, index) => data[index] === value)
}

function readUint16(data: Uint8Array, offset: number): number {
  const high = data[offset]
  const low = data[offset + 1]
  if (high === undefined || low === undefined) throw new Error('truncated integer')
  return high * 0x100 + low
}

function readUint32(data: Uint8Array, offset: number): number {
  return readUint16(data, offset) * 0x10000 + readUint16(data, offset + 2)
}

function ascii(data: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...data.subarray(start, Math.min(end, data.byteLength)))
}
