import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import { encode as encodePng } from 'fast-png'
import { encode as encodeJpeg } from 'jpeg-js'
import { describe, expect, it, vi } from 'vitest'
import {
  EdgeDoAttachmentStore,
  EDGE_R2_IMAGE_LIMITS,
  EdgeR2AttachmentStore,
  resolveEdgeAttachmentStorage,
} from '../src/edge-attachment-store.ts'

class TestDurableObjectStorage {
  private readonly db = new DatabaseSync(':memory:')
  private failedChunkIndex: number | undefined

  sql = {
    exec: <T extends TestRow = TestRow>(
      query: string,
      ...bindings: unknown[]
    ): TestCursor<T> => {
      if (/INSERT INTO dsh_edge_attachment_chunks/u.test(query)
        && bindings[1] === this.failedChunkIndex) {
        this.failedChunkIndex = undefined
        throw new Error('injected attachment chunk failure')
      }
      const statement = this.db.prepare(query)
      const input = bindings.map(binding => binding instanceof ArrayBuffer
        ? new Uint8Array(binding)
        : binding) as SQLInputValue[]
      if (/^(?:SELECT|PRAGMA)\b/iu.test(query.trimStart())) {
        const rows = statement.all(...input) as T[]
        return cursor(rows, 0)
      }
      const result = statement.run(...input)
      return cursor([], Number(result.changes))
    },
  }

  transactionSync<T>(callback: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  failChunkInsert(index: number): void {
    this.failedChunkIndex = index
  }

  close(): void {
    this.db.close()
  }
}

type TestRow = Record<string, SQLOutputValue>

interface TestCursor<T extends TestRow> extends Iterable<T> {
  readonly rowsRead: number
  readonly rowsWritten: number
  toArray(): T[]
}

function cursor<T extends TestRow>(rows: T[], rowsWritten: number): TestCursor<T> {
  return {
    rowsRead: rows.length,
    rowsWritten,
    toArray: () => [...rows],
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  }
}

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

function noisyPng(width = 500, height = 500): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  let state = 0x12345678
  for (let offset = 0; offset < data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      data[offset + channel] = state & 0xff
    }
    data[offset + 3] = 0xff
  }
  return encodePng({ width, height, data })
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

describe('EdgeDoAttachmentStore', () => {
  it('pins, chunks, deduplicates, and restores temporary attachments', async () => {
    const storage = new TestDurableObjectStorage()
    try {
      expect(resolveEdgeAttachmentStorage(storage as never, undefined)).toBe('temporary-do')
      const first = new EdgeDoAttachmentStore(new Context(), { storage: storage as never })
      const data = noisyPng()
      const ref = await first.saveImage({ data, mediaType: 'image/png' })
      await first.saveImage({ data, mediaType: 'image/png' })

      const objects = storage.sql.exec('SELECT digest, bytes FROM dsh_edge_attachment_objects')
        .toArray()
      const chunks = storage.sql.exec('SELECT chunk_index FROM dsh_edge_attachment_chunks')
        .toArray()
      expect(objects).toHaveLength(1)
      expect(chunks.length).toBeGreaterThan(1)
      expect(storage.sql.exec('SELECT stored_bytes FROM dsh_edge_attachment_state').toArray())
        .toEqual([{ stored_bytes: data.byteLength }])

      const restored = new EdgeDoAttachmentStore(new Context(), { storage: storage as never })
      expect((await restored.readImage(ref)).data).toEqual(data)
    } finally {
      storage.close()
    }
  })

  it('refuses quota failures without publishing partial objects', async () => {
    const storage = new TestDurableObjectStorage()
    try {
      resolveEdgeAttachmentStorage(storage as never, undefined)
      const data = png()
      const attachments = new EdgeDoAttachmentStore(new Context(), {
        storage: storage as never,
        maxStoredBytes: data.byteLength - 1,
      })

      await expect(attachments.saveImage({ data, mediaType: 'image/png' }))
        .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
      expect(storage.sql.exec('SELECT digest FROM dsh_edge_attachment_objects').toArray())
        .toEqual([])
      expect(storage.sql.exec('SELECT stored_bytes FROM dsh_edge_attachment_state').toArray())
        .toEqual([{ stored_bytes: 0 }])
    } finally {
      storage.close()
    }
  })

  it('rejects an over-quota image batch without retaining earlier members', async () => {
    const storage = new TestDurableObjectStorage()
    try {
      resolveEdgeAttachmentStorage(storage as never, undefined)
      const first = png()
      const second = jpeg()
      const attachments = new EdgeDoAttachmentStore(new Context(), {
        storage: storage as never,
        maxStoredBytes: first.byteLength + second.byteLength - 1,
      })

      await expect(attachments.saveImages([
        { data: first, mediaType: 'image/png' },
        { data: second, mediaType: 'image/jpeg' },
      ])).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
      expect(storage.sql.exec('SELECT digest FROM dsh_edge_attachment_objects').toArray())
        .toEqual([])
      expect(storage.sql.exec('SELECT digest FROM dsh_edge_attachment_chunks').toArray())
        .toEqual([])
      expect(storage.sql.exec('SELECT stored_bytes FROM dsh_edge_attachment_state').toArray())
        .toEqual([{ stored_bytes: 0 }])
    } finally {
      storage.close()
    }
  })

  it('accounts duplicate members in one batch only once', async () => {
    const storage = new TestDurableObjectStorage()
    try {
      resolveEdgeAttachmentStorage(storage as never, undefined)
      const data = png()
      const attachments = new EdgeDoAttachmentStore(new Context(), {
        storage: storage as never,
        maxStoredBytes: data.byteLength,
      })

      const refs = await attachments.saveImages([
        { data, mediaType: 'image/png', name: 'first.png' },
        { data, mediaType: 'image/png', name: 'second.png' },
      ])
      expect(refs).toHaveLength(2)
      expect(refs[0]?.attachmentId).toBe(refs[1]?.attachmentId)
      expect(storage.sql.exec('SELECT digest FROM dsh_edge_attachment_objects').toArray())
        .toHaveLength(1)
      expect(storage.sql.exec('SELECT stored_bytes FROM dsh_edge_attachment_state').toArray())
        .toEqual([{ stored_bytes: data.byteLength }])
    } finally {
      storage.close()
    }
  })

  it('rolls back metadata, chunks, and accounting after a partial chunk failure', async () => {
    const storage = new TestDurableObjectStorage()
    try {
      resolveEdgeAttachmentStorage(storage as never, undefined)
      const attachments = new EdgeDoAttachmentStore(new Context(), {
        storage: storage as never,
      })
      storage.failChunkInsert(1)

      await expect(attachments.saveImage({ data: noisyPng(), mediaType: 'image/png' }))
        .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
      expect(storage.sql.exec('SELECT digest FROM dsh_edge_attachment_objects').toArray())
        .toEqual([])
      expect(storage.sql.exec('SELECT digest FROM dsh_edge_attachment_chunks').toArray())
        .toEqual([])
      expect(storage.sql.exec('SELECT stored_bytes FROM dsh_edge_attachment_state').toArray())
        .toEqual([{ stored_bytes: 0 }])
    } finally {
      storage.close()
    }
  })

  it('keeps a claimed temporary instance on DO and refuses a missing pinned R2 binding', () => {
    const temporary = new TestDurableObjectStorage()
    const permanent = new TestDurableObjectStorage()
    try {
      expect(resolveEdgeAttachmentStorage(temporary as never, undefined)).toBe('temporary-do')
      expect(resolveEdgeAttachmentStorage(temporary as never, {} as R2Bucket)).toBe('temporary-do')
      expect(resolveEdgeAttachmentStorage(permanent as never, {} as R2Bucket)).toBe('private-r2')
      expect(() => resolveEdgeAttachmentStorage(permanent as never, undefined))
        .toThrow(/pinned private R2 attachment binding is unavailable/u)
    } finally {
      temporary.close()
      permanent.close()
    }
  })
})
