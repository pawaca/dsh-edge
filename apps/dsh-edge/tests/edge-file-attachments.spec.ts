import { createHash } from 'node:crypto'
import { AttachmentError, AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it } from 'vitest'
import {
  EDGE_FILE_ATTACHMENT_ROOT,
  type EdgeAttachmentFiles,
  fileLeafName,
  readFileStream,
  saveFileStream,
  storedFilePath,
} from '../src/edge-file-attachments.ts'

/** An in-memory VFS that records how the store drives it. */
class TestFiles implements EdgeAttachmentFiles {
  readonly entries = new Map<string, Uint8Array>()
  readonly directories = new Set<string>(['/'])
  /** Chunks the writer had pulled when each chunk was stored. */
  readonly pulled: number[] = []
  leases = 0
  failWriteAfter: number | undefined

  async writeFile(path: string, content: ReadableStream<Uint8Array>): Promise<void> {
    const reader = content.getReader()
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        chunks.push(next.value)
        this.pulled.push(chunks.length)
        if (this.failWriteAfter !== undefined && chunks.length >= this.failWriteAfter) {
          throw new Error('injected VFS write failure')
        }
        // Stage what has been written so far, as a chunked VFS would.
        this.entries.set(path, concat(chunks))
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined)
      throw error
    }
    this.entries.set(path, concat(chunks))
  }

  readFile(path: string): Promise<ReadableStream<Uint8Array>> {
    const data = this.entries.get(path)
    if (data === undefined) return Promise.reject(enoent(path))
    let offset = 0
    return Promise.resolve(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= data.byteLength) {
          controller.close()
          return
        }
        controller.enqueue(data.slice(offset, offset + 4))
        offset += 4
      },
    }))
  }

  stat(path: string): Promise<{ size: number; isFile: boolean }> {
    const data = this.entries.get(path)
    if (data !== undefined) return Promise.resolve({ size: data.byteLength, isFile: true })
    if (this.directories.has(path)) return Promise.resolve({ size: 0, isFile: false })
    return Promise.reject(enoent(path))
  }

  mkdir(path: string): Promise<void> {
    this.directories.add(path)
    return Promise.resolve()
  }

  rename(from: string, to: string): Promise<void> {
    const data = this.entries.get(from)
    if (data === undefined) return Promise.reject(enoent(from))
    this.entries.delete(from)
    this.entries.set(to, data)
    return Promise.resolve()
  }

  rm(path: string): Promise<void> {
    this.entries.delete(path)
    return Promise.resolve()
  }

  readonly open = () => {
    this.leases += 1
    return Promise.resolve({
      files: this as EdgeAttachmentFiles,
      [Symbol.dispose]: () => { this.leases -= 1 },
    })
  }
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function* chunksOf(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return concat(chunks)
}

const bytes = (text: string) => new TextEncoder().encode(text)
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

describe('Edge VFS file attachments', () => {
  it('streams a file to its content address under the upstream layout and reads it back verified', async () => {
    const files = new TestFiles()
    const data = concat([bytes('hello, '), bytes('edge '), bytes('files')])
    const ref = await saveFileStream(files.open, {
      data: chunksOf(bytes('hello, '), bytes('edge '), bytes('files')),
      name: 'C:\\Users\\me\\report.pdf',
    })
    const digest = sha256(data)
    expect(ref).toEqual({ attachmentId: AttachmentId(`sha256:${digest}`), name: 'report.pdf', bytes: data.byteLength })
    const path = storedFilePath(ref)
    expect(path).toBe(`${EDGE_FILE_ATTACHMENT_ROOT}/files/${digest.slice(0, 2)}/${digest}/report.pdf`)
    expect([...files.entries.keys()]).toEqual([path])
    // Each chunk was stored before the next was pulled from the request.
    expect(files.pulled).toEqual([1, 2, 3])
    expect(await collect(readFileStream(files.open, ref))).toEqual(data)
    expect(files.leases).toBe(0)
  })

  it('stores an empty file and keeps one object per name for the same bytes', async () => {
    const files = new TestFiles()
    const empty = await saveFileStream(files.open, { data: chunksOf() })
    expect(empty.bytes).toBe(0)
    expect(empty.name).toBe('file')
    const a = await saveFileStream(files.open, { data: chunksOf(bytes('same')), name: 'a.txt' })
    const again = await saveFileStream(files.open, { data: chunksOf(bytes('same')), name: 'a.txt' })
    const b = await saveFileStream(files.open, { data: chunksOf(bytes('same')), name: 'b.txt' })
    expect(again).toEqual(a)
    expect(b.attachmentId).toBe(a.attachmentId)
    expect([...files.entries.keys()].sort((x, y) => x.localeCompare(y)))
      .toEqual([storedFilePath(a), storedFilePath(b), storedFilePath(empty)].sort((x, y) => x.localeCompare(y)))
  })

  it('stops at the size limit, leaving no staged or addressed object', async () => {
    const files = new TestFiles()
    const failure = saveFileStream(files.open, {
      data: chunksOf(bytes('1234'), bytes('5678'), bytes('9')),
    }, 8)
    await expect(failure).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED', message: expect.stringContaining('limited') as unknown })
    expect(files.entries.size).toBe(0)
    expect(files.leases).toBe(0)
  })

  it('removes the staged object when the VFS write or the caller fails', async () => {
    const files = new TestFiles()
    files.failWriteAfter = 2
    await expect(saveFileStream(files.open, { data: chunksOf(bytes('ab'), bytes('cd'), bytes('ef')) }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    expect(files.entries.size).toBe(0)

    files.failWriteAfter = undefined
    const abort = new AbortController()
    async function* aborting() {
      yield bytes('ab')
      abort.abort(new Error('client went away'))
      yield bytes('cd')
    }
    await expect(saveFileStream(files.open, { data: aborting(), signal: abort.signal }))
      .rejects.toThrow('client went away')
    expect(files.entries.size).toBe(0)
    expect(files.leases).toBe(0)
  })

  it('fails reads closed for invalid refs, missing objects, and changed bytes', async () => {
    const files = new TestFiles()
    const ref = await saveFileStream(files.open, { data: chunksOf(bytes('original')), name: 'notes.txt' })
    const read = (target: FileAttachmentRef) => collect(readFileStream(files.open, target))

    await expect(read({ ...ref, attachmentId: AttachmentId('sha256:nope') }))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
    await expect(read({ ...ref, name: '../escape' }))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
    // Same length, different bytes: caught by the digest after the last chunk.
    files.entries.set(storedFilePath(ref), bytes('ORIGINAL'))
    await expect(read(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    // A different length is refused before any byte is returned.
    files.entries.set(storedFilePath(ref), bytes('short'))
    await expect(read(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    files.entries.delete(storedFilePath(ref))
    await expect(read(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await expect(read(ref)).rejects.toBeInstanceOf(AttachmentError)
    expect(files.leases).toBe(0)
  })

  it('sanitizes display names as upstream does', () => {
    expect(fileLeafName(undefined)).toBe('file')
    expect(fileLeafName('/home/me/a.txt')).toBe('a.txt')
    expect(fileLeafName('dir\\b.csv')).toBe('b.csv')
    expect(fileLeafName('what?<>.md')).toBe('what___.md')
    expect(fileLeafName('con.txt')).toBe('_con.txt')
    expect(fileLeafName('trailing. . ')).toBe('trailing')
    expect(fileLeafName('..')).toBe('file')
    expect(fileLeafName('a\u0000b')).toBe('ab')
    const long = fileLeafName('é'.repeat(200))
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(255)
    expect(fileLeafName(long)).toBe(long)
  })
})
