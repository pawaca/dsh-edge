import { Context } from '@deepseek-ai/cordis'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { encode as encodeJpeg } from 'jpeg-js'
import { describe, expect, it, vi } from 'vitest'
import {
  EDGE_OPTIMIZED_IMAGE_LIMITS,
  EDGE_R2_IMAGE_LIMITS,
  EdgeR2AttachmentStore,
} from '../src/edge-attachment-store.ts'
import {
  NORMALIZED_IMAGE_POLICY,
  exifOrientation,
  normalizedDimensions,
  readImageHeader,
  type ImagesBinding,
} from '../src/edge-image-normalization.ts'

/** The bytes of an ASCII string. */
function asciiBytes(text: string): number[] {
  return Array.from(text, character => character.charCodeAt(0))
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array(encodeJpeg({ width, height, data: new Uint8Array(width * height * 4).fill(127) }, 80).data)
}

/** A JPEG with an APP1 Exif segment whose first IFD sets the orientation tag. */
function rotatedJpeg(width: number, height: number, orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]
  const body = asciiBytes('Exif\0\0').concat(tiff)
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]
  const plain = jpeg(width, height)
  return Uint8Array.from([...plain.subarray(0, 2), ...app1, ...plain.subarray(2)])
}

/** A PNG whose IHDR claims a size and whose body is not image data: only a header reader accepts it. */
function pngHeaderOnly(width: number, height: number, colorType = 2): Uint8Array {
  const bytes = new Uint8Array(64)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  bytes[24] = 8
  bytes[25] = colorType
  return bytes
}

function gif(width: number, height: number): Uint8Array {
  return Uint8Array.from(asciiBytes('GIF89a')
    .concat([width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0]))
}

/** An extended WebP header (VP8X) with a size and an alpha flag. */
function webp(width: number, height: number, alpha: boolean): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set(asciiBytes('RIFF'), 0)
  bytes.set(asciiBytes('WEBPVP8X'), 8)
  bytes[16] = 10
  bytes[20] = alpha ? 0x10 : 0
  const w = width - 1
  const h = height - 1
  bytes.set([w & 0xff, (w >> 8) & 0xff, w >> 16, h & 0xff, (h >> 8) & 0xff, h >> 16], 24)
  return bytes
}

interface Call { width?: number, height?: number, fit?: string, format: string, quality?: number, anim?: boolean }

/** An Images binding that records each transform and answers with an image of the requested size and format. */
function fakeImages(options: { fail?: Error, padding?: (quality: number | undefined) => number, turn?: boolean } = {}) {
  const calls: Call[] = []
  const images: ImagesBinding = {
    input: () => ({
      transform: transform => ({
        output: async output => {
          calls.push({ ...transform, ...output })
          if (options.fail !== undefined) throw options.fail
          // `turn` applies a quarter-turn EXIF orientation as Images in production does.
          const width = (options.turn === true ? transform.height : transform.width) ?? 1
          const height = (options.turn === true ? transform.width : transform.height) ?? 1
          const image = output.format === 'image/webp' ? webp(width, height, true) : jpeg(Math.min(width, 64), Math.min(height, 64))
          // A JPEG's header names its own size, so the fake stamps the requested one into the SOF0 segment.
          if (output.format === 'image/jpeg') stampJpegSize(image, width, height)
          return new Response(Uint8Array.from([...image, ...new Uint8Array(options.padding?.(output.quality) ?? 0)]))
        },
      }),
    }),
  }
  return { images, calls }
}

function stampJpegSize(image: Uint8Array, width: number, height: number): void {
  for (let offset = 2; offset < image.byteLength - 9; offset += 1) {
    if (image[offset] === 0xff && image[offset + 1] === 0xc0) {
      image.set([height >> 8, height & 0xff, width >> 8, width & 0xff], offset + 5)
      return
    }
  }
  throw new Error('no SOF0 segment')
}

function memoryBucket(): R2Bucket {
  const objects = new Map<string, Uint8Array>()
  return {
    put: async (key: string, value: ArrayBufferView) => {
      objects.set(key, Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)))
      return {} as R2Object
    },
    get: async (key: string) => {
      const value = objects.get(key)
      return value === undefined ? null : { bytes: async () => Uint8Array.from(value) } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
}

function optimizedStore(images: ImagesBinding): EdgeR2AttachmentStore {
  return new EdgeR2AttachmentStore(new Context(), { bucket: memoryBucket(), images })
}

describe('image headers', () => {
  it('reads PNG, JPEG, GIF, and WebP sizes, transparency, and JPEG orientation without decoding', () => {
    expect(readImageHeader(pngHeaderOnly(3840, 2160))).toEqual({ mediaType: 'image/png', width: 3840, height: 2160, hasAlpha: false, orientation: 1 })
    expect(readImageHeader(pngHeaderOnly(10, 10, 6)).hasAlpha).toBe(true)
    // A tRNS chunk before the image data makes an RGB or palette PNG transparent.
    const withTrns = pngHeaderOnly(10, 10, 3)
    withTrns.set([0, 0, 0, 1, ...asciiBytes('tRNS'), 0, 0, 0, 0, 0], 33)
    expect(readImageHeader(withTrns).hasAlpha).toBe(true)
    expect(readImageHeader(jpeg(4, 3))).toEqual({ mediaType: 'image/jpeg', width: 4, height: 3, hasAlpha: false, orientation: 1 })
    expect(readImageHeader(rotatedJpeg(4, 3, 6)).orientation).toBe(6)
    expect(readImageHeader(gif(300, 200))).toEqual({ mediaType: 'image/gif', width: 300, height: 200, hasAlpha: true, orientation: 1 })
    expect(readImageHeader(webp(5000, 3000, false))).toEqual({ mediaType: 'image/webp', width: 5000, height: 3000, hasAlpha: false, orientation: 1 })
    expect(() => readImageHeader(Uint8Array.of(1, 2, 3))).toThrow(/unsupported/u)
  })

  it('reads the orientation of either byte order and ignores a malformed Exif block', () => {
    const little = Uint8Array.from(asciiBytes('Exif\0\0')
      .concat([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0]))
    expect(exifOrientation(little)).toBe(8)
    expect(exifOrientation(little.subarray(0, 12))).toBe(1)
    expect(exifOrientation(Uint8Array.of(1, 2, 3))).toBe(1)
  })

  it('fits the 2048 x 2048 pixel budget and the long-edge cap, keeping the aspect ratio', () => {
    expect(normalizedDimensions(3840, 2160)).toEqual({ width: 2730, height: 1536 })
    // A phone screenshot is inside the budget, so it keeps its size.
    expect(normalizedDimensions(1170, 2532)).toEqual({ width: 1170, height: 2532 })
    expect(normalizedDimensions(3000, 3000)).toEqual({ width: 2048, height: 2048 })
    expect(normalizedDimensions(1000, 800)).toEqual({ width: 1000, height: 800 })
    expect(normalizedDimensions(8192, 100)).toEqual({ width: 8192, height: 100 })
  })
})

describe('attachment store with the Images binding', () => {
  it('advertises upstream formats and sides, and the bytes the prompt body carries', () => {
    expect(optimizedStore(fakeImages().images).imageLimits).toBe(EDGE_OPTIMIZED_IMAGE_LIMITS)
    expect(new EdgeR2AttachmentStore(new Context(), { bucket: memoryBucket() }).imageLimits).toBe(EDGE_R2_IMAGE_LIMITS)
    expect(EDGE_OPTIMIZED_IMAGE_LIMITS).toMatchObject({ maxImageDimension: 8192, maxImagePixels: 64_000_000, maxMessageImageBytes: 7 * 1024 * 1024 })
    expect(EDGE_OPTIMIZED_IMAGE_LIMITS.mediaTypes).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  })

  it('stores a clean small JPEG as submitted without an Images transformation', async () => {
    const { images, calls } = fakeImages()
    const attachments = optimizedStore(images)
    const data = jpeg(40, 30)
    const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg' })
    expect(calls).toEqual([])
    expect(ref).toMatchObject({ mediaType: 'image/jpeg', width: 40, height: 30, bytes: data.byteLength })
    expect(ref.originalDimensions).toBeUndefined()
    expect((await attachments.readImage(ref)).data).toEqual(data)
  })

  it('downscales a 4K PNG through Images without decoding it in the Worker', async () => {
    const { images, calls } = fakeImages()
    const attachments = optimizedStore(images)
    // The body is not PNG data: a pixel decode would fail, so success shows none ran.
    const source = pngHeaderOnly(3840, 2160)
    await attachments.validateImage({ data: source, mediaType: 'image/png' })
    const ref = await attachments.saveImage({ data: source, mediaType: 'image/png' })
    expect(calls).toEqual([{ width: 2730, height: 1536, fit: 'scale-down', format: 'image/jpeg', quality: 85, anim: false }])
    expect(ref).toMatchObject({ mediaType: 'image/jpeg', width: 2730, height: 1536, originalDimensions: { width: 3840, height: 2160 } })
    expect((await attachments.readImage(ref)).ref).toEqual(ref)
  })

  it('converts WebP and GIF, keeping possible transparency as WebP and taking a GIF\'s first frame', async () => {
    const { images, calls } = fakeImages()
    const attachments = optimizedStore(images)
    expect(await attachments.saveImage({ data: webp(800, 600, false), mediaType: 'image/webp' }))
      .toMatchObject({ mediaType: 'image/jpeg', width: 800, height: 600 })
    expect(await attachments.saveImage({ data: gif(300, 200), mediaType: 'image/gif' }))
      .toMatchObject({ mediaType: 'image/webp', width: 300, height: 200 })
    expect(calls.map(call => [call.format, call.anim])).toEqual([['image/jpeg', false], ['image/webp', false]])
  })

  it('sends a rotated JPEG through Images and reads the turn from the output\'s shape', async () => {
    // Images in production applies the EXIF quarter turn: the stored image is upright, at its original size.
    const turning = fakeImages({ turn: true })
    const upright = await optimizedStore(turning.images).saveImage({ data: rotatedJpeg(40, 30, 6), mediaType: 'image/jpeg' })
    expect(turning.calls).toHaveLength(1)
    expect(upright).toMatchObject({ mediaType: 'image/jpeg', width: 30, height: 40 })
    expect(upright.originalDimensions).toBeUndefined()
    // Its local development mode does not turn, which must not read as a resize.
    const unturned = await optimizedStore(fakeImages().images).saveImage({ data: rotatedJpeg(40, 30, 6), mediaType: 'image/jpeg' })
    expect(unturned).toMatchObject({ width: 40, height: 30 })
    expect(unturned.originalDimensions).toBeUndefined()
    // A turned downscale records the upright original.
    const large = await optimizedStore(fakeImages({ turn: true }).images).saveImage({ data: rotatedJpeg(4000, 2000, 6), mediaType: 'image/jpeg' })
    expect(large).toMatchObject({ width: 1448, height: 2896, originalDimensions: { width: 2000, height: 4000 } })
  })

  it('stops the quality ladder at the first output inside the byte target, else keeps the smallest', async () => {
    const over = NORMALIZED_IMAGE_POLICY.maxBytes
    const fitsAt75 = fakeImages({ padding: quality => quality === 85 ? over : 0 })
    await optimizedStore(fitsAt75.images).saveImage({ data: pngHeaderOnly(3000, 3000), mediaType: 'image/png' })
    expect(fitsAt75.calls.map(call => call.quality)).toEqual([85, 75])
    const never = fakeImages({ padding: quality => over + (quality === 75 ? 1 : 10) })
    const ref = await optimizedStore(never.images).saveImage({ data: pngHeaderOnly(3000, 3000), mediaType: 'image/png' })
    expect(never.calls.map(call => call.quality)).toEqual([85, 75, 60])
    expect(ref.bytes).toBe(jpegSize(2048, 2048) + over + 1)
  })

  it('keeps an image inside the plain limits as submitted when Images fails, and refuses a larger one saying why', async () => {
    const quota = new Error('9422: monthly transformation limit reached')
    const { images } = fakeImages({ fail: quota })
    const attachments = optimizedStore(images)
    const rotated = rotatedJpeg(40, 30, 6)
    const kept = await attachments.saveImage({ data: rotated, mediaType: 'image/jpeg' })
    expect(kept).toMatchObject({ mediaType: 'image/jpeg', width: 40, height: 30, bytes: rotated.byteLength })
    const refused = await attachments.saveImage({ data: pngHeaderOnly(3840, 2160), mediaType: 'image/png' }).then(() => undefined, (error: unknown) => error)
    expect(refused).toBeInstanceOf(AttachmentError)
    expect(refused).toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    expect((refused as Error).message).toMatch(/Image optimization is unavailable \(9422: monthly transformation limit reached\).*2000 px per side and 3\.5 MiB/u)
  })

  it('refuses a declared type that does not match, and sizes over the Images limits, from the header', async () => {
    const attachments = optimizedStore(fakeImages().images)
    await expect(attachments.saveImage({ data: gif(10, 10), mediaType: 'image/png' })).rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' })
    await expect(attachments.saveImage({ data: webp(9000, 10, false), mediaType: 'image/webp' })).rejects.toMatchObject({ code: 'IMAGE_DIMENSION_TOO_LARGE' })
    await expect(attachments.saveImage({ data: webp(8000, 8100, false), mediaType: 'image/webp' })).rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
  })
})

describe('attachment store without the Images binding', () => {
  it('keeps PNG and JPEG only, decoded in the Worker, as before', async () => {
    const images = vi.fn()
    const attachments = new EdgeR2AttachmentStore(new Context(), { bucket: memoryBucket() })
    await expect(attachments.saveImage({ data: webp(10, 10, false), mediaType: 'image/webp' })).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(attachments.saveImage({ data: pngHeaderOnly(100, 100), mediaType: 'image/png' })).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(attachments.saveImage({ data: pngHeaderOnly(2001, 10), mediaType: 'image/png' })).rejects.toMatchObject({ code: 'IMAGE_DIMENSION_TOO_LARGE' })
    expect(images).not.toHaveBeenCalled()
  })
})

function jpegSize(width: number, height: number): number {
  return jpeg(Math.min(width, 64), Math.min(height, 64)).byteLength
}
