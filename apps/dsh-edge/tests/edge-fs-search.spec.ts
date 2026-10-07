import { describe, expect, it } from 'vitest'
import { apply, GREP_MAX_COLLECTED_CHARS, GREP_MAX_COLLECTED_MATCHES, GREP_MAX_FILE_BYTES, SEARCH_MAX_ENTRIES } from '../src/edge-fs-search.ts'

type Tool = {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  output: { render: (args: unknown, value: never) => Array<{ text: string }>; presentationMeta: (args: unknown, value: never) => unknown }
}

/** An in-memory stand-in for the workspace VFS: files carry content and mtime; directories are implied. */
function workspace(files: Record<string, string | { content: string; mtime: number }>) {
  const entries = new Map(Object.entries(files).map(([path, value], index) =>
    [path, typeof value === 'string' ? { content: value, mtime: index + 1 } : value]))
  const isDirectory = (path: string) => [...entries.keys()].some(file => file.startsWith(`${path}/`))
  const calls = { stat: 0, readdir: 0, widest: 0 }
  const encoder = new TextEncoder()
  return {
    calls,
    /** Replace a file's content without its listing noticing, as a concurrent writer would. */
    replace(path: string, content: string) { entries.get(path)!.content = content },
    async stat(path: string) {
      calls.stat++
      const file = entries.get(path)
      if (file !== undefined) return { size: file.content.length, mtime: file.mtime, isFile: true, isDirectory: false, isSymbolicLink: false }
      if (isDirectory(path)) return { size: 0, mtime: 0, isFile: false, isDirectory: true, isSymbolicLink: false }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    async readdir(directory: string, options?: { limit?: number }) {
      calls.readdir++
      const children = new Map<string, { size: number; mtime: number; isFile: boolean; isDirectory: boolean }>()
      for (const [path, file] of entries) {
        if (!path.startsWith(`${directory}/`)) continue
        const [name, ...rest] = path.slice(directory.length + 1).split('/')
        children.set(name!, rest.length === 0
          ? { size: file.content.length, mtime: file.mtime, isFile: true, isDirectory: false }
          : { size: 0, mtime: 0, isFile: false, isDirectory: true })
      }
      const listed = [...children].sort(([left], [right]) => left < right ? -1 : 1).slice(0, options?.limit)
      calls.widest = Math.max(calls.widest, listed.length)
      return listed.map(([name, info]) => ({ name, ...info }))
    },
    async readFile(path: string) {
      const bytes = encoder.encode(entries.get(path)!.content)
      let offset = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.byteLength) return controller.close()
          controller.enqueue(bytes.slice(offset, offset + 65_536))
          offset += 65_536
        },
      })
    },
  }
}

function tools(vfs: ReturnType<typeof workspace>, cwd = '/workspace', signal = new AbortController().signal) {
  const registered = new Map<string, Tool>()
  const resolve = (path: string, base: string) => {
    const joined = path.startsWith('/') ? path : `${base}/${path}`
    const parts: string[] = []
    for (const segment of joined.split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') parts.pop()
      else parts.push(segment)
    }
    return `/${parts.join('/')}`
  }
  const ctx = {
    systemPrompt: { section() {}, getSectionOrder() { return 0 } },
    tools: { register(tool: Tool) { registered.set(tool.name, tool) }, get(name: string) { return registered.get(name) } },
    on() {},
    fs: {
      searchScope: () => ({ vfs, cwd }),
      resolve: async (path: string, options: { cwd: string }) => ({ targetKey: resolve(path, options.cwd), displayPath: path }),
    },
  }
  apply(ctx as never)
  const exec = { signal, agent: { session: { header: { cwd } } } }
  return {
    run: (name: string, args: Record<string, unknown>) => registered.get(name)!.execute(args, exec),
    render: (name: string, value: unknown) => registered.get(name)!.output.render({}, value as never)[0]!.text,
    meta: (name: string, value: unknown) => registered.get(name)!.output.presentationMeta({}, value as never),
  }
}

describe('glob over the workspace VFS', () => {
  it('matches a slashless pattern at any depth, oldest first, and skips VCS metadata', async () => {
    const search = tools(workspace({
      '/workspace/src/b.ts': { content: 'b', mtime: 30 },
      '/workspace/a.ts': { content: 'a', mtime: 20 },
      '/workspace/src/deep/c.ts': { content: 'c', mtime: 10 },
      '/workspace/.git/hooks/x.ts': 'vcs',
      '/workspace/.hidden/d.ts': { content: 'd', mtime: 40 },
      '/workspace/readme.md': 'r',
    }))
    expect(await search.run('glob', { pattern: '*.ts' })).toEqual({
      root: '.',
      paths: ['src/deep/c.ts', 'a.ts', 'src/b.ts', '.hidden/d.ts'],
    })
    expect(await search.run('glob', { pattern: 'src/*.ts' })).toEqual({ root: '.', paths: ['src/b.ts'] })
    expect(await search.run('glob', { pattern: '*.{md,ts}', path: 'src' })).toEqual({ root: 'src', paths: ['src/deep/c.ts', 'src/b.ts'] })
    expect(search.render('glob', { root: '.', paths: [] })).toBe('No files found')
  })

  it.each(['[', 'a[b', '{a,b', 'a}', '{a,{b,c}', '[z-a].ts', 'x\\'])('rejects the malformed glob %s as ripgrep does', async pattern => {
    const search = tools(workspace({ '/workspace/a.ts': 'a' }))
    await expect(search.run('glob', { pattern })).rejects.toMatchObject({ code: 'SEARCH_INVALID_PATTERN' })
    await expect(search.run('grep', { pattern: 'a', include: pattern })).rejects.toMatchObject({ code: 'SEARCH_INVALID_PATTERN' })
  })

  it('accepts escaped and closed glob syntax', async () => {
    const search = tools(workspace({ '/workspace/[x].ts': 'a', '/workspace/b.ts': 'b' }))
    expect(await search.run('glob', { pattern: '\\[x\\].ts' })).toEqual({ root: '.', paths: ['[x].ts'] })
    expect(await search.run('glob', { pattern: '[]ab].ts' })).toEqual({ root: '.', paths: ['b.ts'] })
    expect(await search.run('glob', { pattern: '[a-c].ts' })).toEqual({ root: '.', paths: ['b.ts'] })
  })

  it('accepts nested alternates, as ripgrep 15 does', async () => {
    const search = tools(workspace({ '/workspace/ab.ts': '', '/workspace/ac.ts': '', '/workspace/ad.ts': '', '/workspace/ae.ts': '' }))
    expect(await search.run('glob', { pattern: 'a{b,{c,d}}.ts' })).toEqual({ root: '.', paths: ['ab.ts', 'ac.ts', 'ad.ts'] })
  })

  it('sorts by the mtime its directory listing reports, without a stat per file', async () => {
    const vfs = workspace(Object.fromEntries(Array.from({ length: 50 }, (_, index) =>
      [`/workspace/d${String(index % 5)}/f${String(index)}.txt`, { content: '', mtime: 100 - index }])))
    const result = await tools(vfs).run('glob', { pattern: '*.txt' }) as { paths: string[] }
    expect(result.paths[0]).toBe('d4/f49.txt')
    expect(result.paths).toHaveLength(50)
    expect(vfs.calls).toMatchObject({ stat: 1, readdir: 6 })
  })

  it('refuses a walk beyond its entry cap without listing past it', async () => {
    const vfs = workspace(Object.fromEntries(Array.from({ length: SEARCH_MAX_ENTRIES + 50 }, (_, index) => [`/workspace/f${String(index)}.txt`, ''])))
    await expect(tools(vfs).run('glob', { pattern: '*' })).rejects.toMatchObject({ code: 'SEARCH_RAW_OUTPUT_OVERFLOW' })
    expect(vfs.calls.widest).toBe(SEARCH_MAX_ENTRIES + 1)
  })

  it('stops walking once the call is cancelled', async () => {
    const vfs = workspace({ '/workspace/a/b.ts': '' })
    const controller = new AbortController()
    controller.abort(new Error('timed out'))
    await expect(tools(vfs, '/workspace', controller.signal).run('glob', { pattern: '*' })).rejects.toMatchObject({ code: 'SEARCH_ABORTED' })
    expect(vfs.calls.readdir).toBe(0)
  })
})

describe('grep over the workspace VFS', () => {
  const files = {
    '/workspace/src/app.ts': 'const answer = 42\nexport { answer }\r\n',
    '/workspace/src/app.js': 'const answer = 41\n',
    '/workspace/notes.md': 'the answer is here\n',
    '/workspace/.env': 'answer=secret\n',
    '/workspace/.git/config': 'answer\n',
    '/workspace/image.bin': 'answer\u0000\u0001\n',
  }

  it('searches visible text files and honors include at any depth', async () => {
    const search = tools(workspace(files))
    expect(await search.run('grep', { pattern: 'answer' })).toEqual({ matches: [
      { path: 'notes.md', lineNumber: 1, line: 'the answer is here' },
      { path: 'src/app.js', lineNumber: 1, line: 'const answer = 41' },
      { path: 'src/app.ts', lineNumber: 1, line: 'const answer = 42' },
      { path: 'src/app.ts', lineNumber: 2, line: 'export { answer }' },
    ] })
    expect(await search.run('grep', { pattern: 'answer = \\d+', include: '*.ts' })).toEqual({ matches: [
      { path: 'src/app.ts', lineNumber: 1, line: 'const answer = 42' },
    ] })
    expect(await search.run('grep', { pattern: 'secret', path: '.env' })).toEqual({ matches: [
      { path: '.env', lineNumber: 1, line: 'answer=secret' },
    ] })
    expect(search.render('grep', { matches: [] })).toBe('No matches found')
  })

  it('rejects a pattern RE2 cannot compile and runs a backtracking pattern in linear time', async () => {
    const search = tools(workspace({ '/workspace/a.txt': `${'a'.repeat(50_000)}!\n` }))
    await expect(search.run('grep', { pattern: '(a' })).rejects.toMatchObject({ code: 'SEARCH_INVALID_PATTERN' })
    await expect(search.run('grep', { pattern: '(?=a)' })).rejects.toMatchObject({ code: 'SEARCH_INVALID_PATTERN' })
    const started = Date.now()
    expect(await search.run('grep', { pattern: '^(a+)+$' })).toEqual({ matches: [] })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('stops reading a file once its bytes pass the size cap', async () => {
    const vfs = workspace({ '/workspace/grow.txt': 'hit\n' })
    const search = tools(vfs)
    vfs.replace('/workspace/grow.txt', `hit\n${'x'.repeat(GREP_MAX_FILE_BYTES)}`)
    expect(await search.run('grep', { pattern: 'hit' })).toEqual({ matches: [] })
  })

  it('caps search-card metadata even when every match is in one file', async () => {
    const line = 'hit'.padEnd(1_900, 'x')
    const search = tools(workspace({ '/workspace/one.txt': `${line}\n`.repeat(250) }))
    const value = await search.run('grep', { pattern: 'hit' })
    const meta = search.meta('grep', value) as { files: Array<{ matches: unknown[] }>; truncated: boolean; total: number }
    expect(new TextEncoder().encode(JSON.stringify(meta)).byteLength).toBeLessThanOrEqual(65_536)
    expect(meta.truncated).toBe(true)
    expect(meta.total).toBe(250)
    expect(meta.files[0]!.matches.length).toBeGreaterThan(0)
  })

  it('refuses to hold more matched text than its cap', async () => {
    const line = `hit${'x'.repeat(1024 * 1024)}`
    const files = Object.fromEntries(Array.from({ length: Math.ceil(GREP_MAX_COLLECTED_CHARS / line.length) + 1 },
      (_, index) => [`/workspace/min${String(index)}.js`, `${line}\n`]))
    await expect(tools(workspace(files)).run('grep', { pattern: 'hit' })).rejects.toMatchObject({ code: 'SEARCH_RAW_OUTPUT_OVERFLOW' })
  })

  it('refuses to collect more matches than its cap', async () => {
    const search = tools(workspace({ '/workspace/many.txt': 'hit\n'.repeat(GREP_MAX_COLLECTED_MATCHES + 1) }))
    await expect(search.run('grep', { pattern: 'hit' })).rejects.toMatchObject({ code: 'SEARCH_RAW_OUTPUT_OVERFLOW' })
  })
})
