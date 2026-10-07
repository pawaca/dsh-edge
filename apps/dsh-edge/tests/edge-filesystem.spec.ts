import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { EdgeFileSystem } from '../src/edge-filesystem.ts'

async function withFile(chunks: Uint8Array[], run: (fs: EdgeFileSystem, reads: () => number, cancelled: ReturnType<typeof vi.fn>) => Promise<void>) {
  const ctx = new Context()
  await ctx.plugin(EdgeFileSystem)
  let reads = 0
  const cancelled = vi.fn()
  const vfs = {
    readFile: async () => new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[reads++]
        if (chunk === undefined) controller.close()
        else controller.enqueue(chunk)
      },
      cancel: cancelled,
    }, { highWaterMark: 0 }),
  }
  try {
    const fs = ctx.fs as EdgeFileSystem
    await fs.runInScope(vfs as never, '/workspace', () => run(fs, () => reads, cancelled))
  } finally { await ctx.fiber.dispose() }
}

const encode = (text: string) => new TextEncoder().encode(text)

describe('bounded VFS preview reads', () => {
  it.each(['text', 'bytes'] as const)('preserves typed open failures for %s previews', async kind => {
    const ctx = new Context()
    await ctx.plugin(EdgeFileSystem)
    const fs = ctx.fs as EdgeFileSystem
    const failure = Object.assign(new Error('file deleted before open'), { code: 'ENOENT' })
    const readFile = vi.fn().mockRejectedValue(failure)
    try {
      await fs.runInScope({ readFile } as never, '/workspace', async () => {
        const target = await fs.resolve('deleted.txt')
        const read = () => kind === 'text' ? fs.streamText(target) : fs.readByteRange(target, { offset: 0, length: 1 })
        await expect(read()).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: failure })
        const typed = new FsError('already classified', 'FS_NOT_FOUND')
        readFile.mockRejectedValue(typed)
        await expect(read()).rejects.toBe(typed)
      })
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['text', 'bytes'] as const)('classifies consumption failures and preserves cancellation for %s', async kind => {
    const ctx = new Context()
    await ctx.plugin(EdgeFileSystem)
    const fs = ctx.fs as EdgeFileSystem
    try {
      for (const failure of [new Error('read failed'), new TypeError('VFS transport failed'), new FsError('typed', 'FS_NOT_FOUND'), new DOMException('cancelled', 'AbortError')]) {
        const stream = new ReadableStream<Uint8Array>({ pull() { throw failure } }, { highWaterMark: 0 })
        await fs.runInScope({ readFile: async () => stream } as never, '/workspace', async () => {
          const target = await fs.resolve('a.txt')
          const read = async () => {
            if (kind === 'bytes') return fs.readByteRange(target, { offset: 0, length: 1 })
            for await (const chunk of await fs.streamText(target)) void chunk
          }
          if (failure instanceof FsError || failure.name === 'AbortError') await expect(read()).rejects.toBe(failure)
          else await expect(read()).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: failure })
          expect(stream.locked).toBe(false)
        })
      }
      const controller = new AbortController()
      const reason = new TypeError('custom cancellation')
      const stream = new ReadableStream<Uint8Array>({ pull() { controller.abort(reason); throw reason } }, { highWaterMark: 0 })
      await fs.runInScope({ readFile: async () => stream } as never, '/workspace', async () => {
        const target = await fs.resolve('a.txt')
        const read = async () => {
          if (kind === 'bytes') return fs.readByteRange(target, { offset: 0, length: 1 }, controller.signal)
          for await (const chunk of await fs.streamText(target, controller.signal)) void chunk
        }
        await expect(read()).rejects.toBe(reason)
        expect(stream.locked).toBe(false)
      })
    } finally { await ctx.fiber.dispose() }
  })

  it('does not mask invalid UTF-8 with a cleanup failure', async () => {
    const ctx = new Context()
    await ctx.plugin(EdgeFileSystem)
    const fs = ctx.fs as EdgeFileSystem
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array([0xff])) },
      cancel() { throw new Error('cleanup failed') },
    }, { highWaterMark: 0 })
    try {
      await fs.runInScope({ readFile: async () => stream } as never, '/workspace', async () => {
        const source = await fs.streamText(await fs.resolve('a.txt'))
        await expect(source[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
        expect(stream.locked).toBe(false)
      })
    } finally { await ctx.fiber.dispose() }
  })

  it('decodes split UTF-8 and CRLF without joining the whole file', async () => {
    const text = encode('甲\r\n乙\r丙')
    await withFile([text.slice(0, 1), text.slice(1, 4), text.slice(4)], async fs => {
      const source = await fs.streamText(await fs.resolve('a.txt'))
      let result = ''
      for await (const chunk of source) result += chunk
      expect(result).toBe('甲\n乙\n丙')
    })
  })

  it('cancels a text page before pulling the unused file tail', async () => {
    await withFile([encode('first\n'), encode('unused')], async (fs, reads, cancelled) => {
      for await (const chunk of await fs.streamText(await fs.resolve('a.txt'))) {
        expect(chunk).toBe('first\n')
        break
      }
      expect(reads()).toBe(1)
      expect(cancelled).toHaveBeenCalledOnce()
    })
  })

  it.each([new Uint8Array([0xff]), encode('binary\0data')])('rejects non-text preview data', async bytes => {
    await withFile([bytes], async fs => {
      const source = await fs.streamText(await fs.resolve('a.bin'))
      await expect(source[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    })
  })

  it('reads a byte window from a larger file and stops at the window boundary', async () => {
    await withFile([encode('abcd'), encode('efgh'), encode('unused')], async (fs, reads, cancelled) => {
      const result = await fs.readByteRange(await fs.resolve('a.bin'), { offset: 3, length: 3 })
      expect(new TextDecoder().decode(result)).toBe('def')
      expect(reads()).toBe(2)
      expect(cancelled).toHaveBeenCalledOnce()
    })
  })

  it('returns the remaining bytes at EOF and refuses an aborted read', async () => {
    await withFile([encode('abcd')], async fs => {
      const target = await fs.resolve('a.bin')
      expect(await fs.readByteRange(target, { offset: 3, length: 3 })).toEqual(encode('d'))
      const signal = AbortSignal.abort(new Error('preview cancelled'))
      await expect(fs.readByteRange(target, { offset: 0, length: 1 }, signal)).rejects.toThrow('preview cancelled')
    })
  })
})

describe('provider watching', () => {
  it('invalidates a file or a directory from observed writes until closed', async () => {
    const ctx = new Context()
    await ctx.plugin(EdgeFileSystem)
    const fs = ctx.fs as EdgeFileSystem
    try {
      await fs.runInScope({} as never, '/workspace', async () => {
        const file = await fs.resolve('notes/a.txt')
        const directory = await fs.resolve('notes')
        const onFile = vi.fn()
        const onDirectory = vi.fn()
        const closeFile = await fs.watch(file, onFile, new AbortController().signal)
        const closeDirectory = await fs.watch(directory, onDirectory, new AbortController().signal)
        const observe = async (path: string) => ctx.emit('fs/observed', await fs.resolve(path), { kind: 'present', version: 'v' } as never, undefined)
        await observe('notes/a.txt')
        await observe('notes/b.txt')
        await observe('notes/deep/c.txt')
        expect(onFile).toHaveBeenCalledOnce()
        expect(onDirectory).toHaveBeenCalledTimes(2)
        await closeFile()
        await closeDirectory()
        await observe('notes/a.txt')
        expect(onFile).toHaveBeenCalledOnce()
        const aborted = new AbortController()
        aborted.abort()
        await expect(fs.watch(file, onFile, aborted.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
      })
    } finally { await ctx.fiber.dispose() }
  })
})

describe('guarded writes', () => {
  it('lets one of two concurrent writes from the same version win and fails the other as stale', async () => {
    const ctx = new Context()
    await ctx.plugin(EdgeFileSystem)
    const fs = ctx.fs as EdgeFileSystem
    const files = new Map([['/workspace/shared.txt', { content: 'base\n', mtime: 1 }]])
    let clock = 1
    // Every call yields, so unserialized stat → check → write sequences would interleave.
    const tick = () => new Promise(resolve => setTimeout(resolve, 0))
    const vfs = {
      stat: async (path: string) => {
        await tick()
        const file = files.get(path)
        if (file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return { size: file.content.length, mtime: file.mtime, isFile: true, isDirectory: false, isSymbolicLink: false }
      },
      readFile: async (path: string) => { await tick(); return files.get(path)?.content ?? '' },
      writeFile: async (path: string, content: string) => { await tick(); files.set(path, { content, mtime: ++clock }) },
      mkdir: async () => { await tick() },
    }
    try {
      await fs.runInScope(vfs as never, '/workspace', async () => {
        const target = await fs.resolve('shared.txt')
        const observed = await fs.stat(target)
        const guard = { kind: 'replaceIfVersion', version: observed!.version } as const
        const results = await Promise.allSettled([
          fs.writeText(target, 'first\n', guard),
          fs.editText(target, { oldString: 'base', newString: 'second', replaceAll: false }, { version: observed!.version }),
        ])
        expect(results[0].status).toBe('fulfilled')
        expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'FS_STALE_VERSION' } })
        expect(files.get('/workspace/shared.txt')?.content).toBe('first\n')
      })
    } finally { await ctx.fiber.dispose() }
  })
})
