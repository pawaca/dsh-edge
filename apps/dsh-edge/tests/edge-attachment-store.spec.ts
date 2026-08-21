import { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import { encode as encodePng } from 'fast-png'
import { encode as encodeJpeg } from 'jpeg-js'
import { describe, expect, it, vi } from 'vitest'
import {
  EDGE_R2_IMAGE_LIMITS,
  EdgeR2AttachmentStore,
} from '../src/edge-attachment-store.ts'

function memoryBucket() {
  const objects = new Map<string, Uint8Array>()
  const put = vi.fn(async (key: string, value: ArrayBufferView) => {
    objects.set(key, Uint8Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    ))
    return {} as R2Object
  })
  const get = vi.fn(async (key: string) => {
    const value = objects.get(key)
    if (value === undefined) return null
    return {
      bytes: async () => Uint8Array.from(value),
    } as unknown as R2ObjectBody
  })
  return {
    bucket: { put, get } as unknown as R2Bucket,
    get,
    objects,
    put,
  }
}

function png(width = 2, height = 2): Uint8Array {
  return encodePng({
    width,
    height,
    data: new Uint8Array(width * height * 4).fill(127),
  })
}

function jpeg(width = 2, height = 2): Uint8Array {
  return new Uint8Array(encodeJpeg({
    width,
    height,
    data: new Uint8Array(width * height * 4).fill(127),
  }, 80).data)
}

function store(bucket: R2Bucket): EdgeR2AttachmentStore {
  return new EdgeR2AttachmentStore(new Context(), { bucket })
}

describe('EdgeR2AttachmentStore', () => {
  it('fully validates, content-addresses, and verifies PNG bytes in private R2', async () => {
    const memory = memoryBucket()
    const attachments = store(memory.bucket)
    const data = png()

    const ref = await attachments.saveImage({
      data,
      mediaType: 'image/png',
      name: '/Users/alice/Desktop/\u0000 image.png',
    })

    expect(String(ref.attachmentId)).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(ref).toMatchObject({
      mediaType: 'image/png',
      bytes: data.byteLength,
      width: 2,
      height: 2,
      name: 'image.png',
    })
    expect(memory.put).toHaveBeenCalledOnce()
    expect(memory.put.mock.calls[0]?.[0]).toMatch(
      /^attachments\/v1\/objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/u,
    )
    const stored = await attachments.readImage(ref)
    expect(stored.ref).toEqual(ref)
    expect(stored.data).toEqual(data)
  })

  it('fully decodes the advertised JPEG format', async () => {
    const memory = memoryBucket()
    const attachments = store(memory.bucket)
    const data = jpeg(3, 2)

    const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg' })

    expect(ref).toMatchObject({ mediaType: 'image/jpeg', width: 3, height: 2 })
    expect(await attachments.readImage(ref)).toMatchObject({ ref })
    expect(EDGE_R2_IMAGE_LIMITS.mediaTypes).toEqual(['image/png', 'image/jpeg'])
  })

  it('validates an entire batch before starting any R2 write', async () => {
    const memory = memoryBucket()
    const attachments = store(memory.bucket)

    await expect(attachments.saveImages([
      { data: png(), mediaType: 'image/png' },
      { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' },
    ])).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    expect(memory.put).not.toHaveBeenCalled()
  })

  it('rejects declared-type mismatches and dimensions before decode allocation', async () => {
    const memory = memoryBucket()
    const attachments = store(memory.bucket)
    await expect(attachments.validateImage({
      data: png(),
      mediaType: 'image/jpeg',
    })).rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' })

    const oversizedHeader = png()
    oversizedHeader.set([0, 0, 0x08, 0x01], 16)
    await expect(attachments.validateImage({
      data: oversizedHeader,
      mediaType: 'image/png',
    })).rejects.toMatchObject({ code: 'IMAGE_DIMENSION_TOO_LARGE' })
  })

  it('fails closed for invalid refs, missing objects, and corrupt bytes', async () => {
    const memory = memoryBucket()
    const attachments = store(memory.bucket)
    const data = png()
    const ref = await attachments.saveImage({ data, mediaType: 'image/png' })
    const key = memory.put.mock.calls[0]?.[0]
    expect(key).toBeTypeOf('string')
    memory.objects.set(key!, Uint8Array.of(1, 2, 3))

    await expect(attachments.readImage(ref)).rejects.toMatchObject({
      code: 'ATTACHMENT_CORRUPT',
    })
    await expect(attachments.readImage({
      ...ref,
      attachmentId: AttachmentId(`sha256:${'0'.repeat(64)}`),
    })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await expect(attachments.readImage({
      ...ref,
      attachmentId: 'not-a-content-id' as ReturnType<typeof AttachmentId>,
    })).rejects.toBeInstanceOf(AttachmentError)
  })

  it('honors cancellation before reading private R2', async () => {
    const memory = memoryBucket()
    const attachments = store(memory.bucket)
    const ref = await attachments.saveImage({ data: png(), mediaType: 'image/png' })
    const controller = new AbortController()
    controller.abort()

    await expect(attachments.readImage(ref, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(memory.get).not.toHaveBeenCalled()
  })
})
