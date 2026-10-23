import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FILE_REFERENCE_PROMPT } from '@deepseek-ai/dsh-file-reference'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import {
  EdgeFileReferenceService,
  rankCandidates,
  resolveWithin,
  splitQuery,
  type EdgeReferenceEntry,
} from '../src/edge-file-reference.ts'

function entry(name: string, kind: 'file' | 'directory' = 'file'): EdgeReferenceEntry {
  return { name, isFile: kind === 'file', isDirectory: kind === 'directory' }
}

function agentAt(cwd: string | undefined, id = 'session-a'): Agent {
  return { session: { id, header: { cwd } } } as unknown as Agent
}

async function provider(tree: Record<string, EdgeReferenceEntry[]>, config: { maxResults?: number, maxEntries?: number } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: 'test persona' })
  const reads: { path: string, limit?: number }[] = []
  await ctx.plugin(EdgeFileReferenceService, {
    ...config,
    withFiles: read => read({
      readdir: (path: string, options?: { limit?: number }) => {
        reads.push({ path, ...options?.limit === undefined ? {} : { limit: options.limit } })
        const entries = tree[path]
        return entries === undefined
          ? Promise.reject(new Error(`ENOENT: ${path}`))
          : Promise.resolve(entries.slice(0, options?.limit))
      },
    }),
  })
  const paths = () => reads.map(read => read.path)
  return { ctx, reads, paths, service: ctx.fileReferences }
}

const signal = () => AbortSignal.timeout(1_000)

describe('EdgeFileReferenceService', () => {
  it('fuzzy-ranks a recursive index for a bare fragment, skipping excluded and hidden directories', async () => {
    const { service, paths } = await provider({
      '/workspace': [entry('docs', 'directory'), entry('node_modules', 'directory'), entry('.cache', 'directory'), entry('read.txt')],
      '/workspace/docs': [entry('README.md'), entry('guide', 'directory')],
      '/workspace/docs/guide': [entry('intro.md')],
      '/workspace/node_modules': [entry('README.md')],
      '/workspace/.cache': [entry('README.md')],
    })
    const agent = agentAt('/workspace')
    // `rdm` is an in-order subsequence of docs/README.md only; for `read`, the exact name ranks first.
    expect(await service.list(agent, 'rdm', signal())).toEqual([{ path: 'docs/README.md', kind: 'file' }])
    expect(await service.list(agent, 'read', signal())).toEqual([
      { path: 'read.txt', kind: 'file' },
      { path: 'docs/README.md', kind: 'file' },
    ])
    expect(await service.list(agent, 'intro', signal())).toEqual([{ path: 'docs/guide/intro.md', kind: 'file' }])
    // One walk serves every bare query; excluded directories are never read, and a
    // hidden one is walked but kept out of a bare query's results.
    expect(paths()).toEqual(['/workspace', '/workspace/.cache', '/workspace/docs', '/workspace/docs/guide'])
  })

  it('indexes the directory working_directory selected, not the one the session began in', async () => {
    const { ctx, service, paths } = await provider({
      '/workspace': [entry('top.txt')],
      '/workspace/proj': [entry('inner.txt')],
    })
    class Current extends Service {
      constructor(c: Context) { super(c, 'workingDirectory') }
      get() { return '/workspace/proj' }
    }
    await ctx.plugin(Current)
    expect(await service.list(agentAt('/workspace'), 'i', signal())).toEqual([{ path: 'inner.txt', kind: 'file' }])
    expect(paths()).toEqual(['/workspace/proj'])
  })

  it('bounds the index by maxEntries and asks each listing for no more than remains', async () => {
    const { service, reads } = await provider({
      '/workspace': [entry('a', 'directory'), entry('b', 'directory')],
      '/workspace/a': [entry('a1.txt'), entry('a2.txt'), entry('a3.txt')],
      '/workspace/b': [entry('b1.txt')],
    }, { maxEntries: 4 })
    expect(await service.list(agentAt('/workspace'), 'txt', signal())).toEqual([
      { path: 'a/a1.txt', kind: 'file' },
      { path: 'a/a2.txt', kind: 'file' },
    ])
    expect(reads).toEqual([{ path: '/workspace', limit: 4 }, { path: '/workspace/a', limit: 2 }])
  })

  it('answers from a stale index after a tool result in any session and reads its replacement behind the query', async () => {
    const tree: Record<string, EdgeReferenceEntry[]> = { '/workspace': [entry('old.txt')] }
    const { ctx, service, paths } = await provider(tree)
    const agent = agentAt('/workspace')
    expect(await service.list(agent, 'txt', signal())).toEqual([{ path: 'old.txt', kind: 'file' }])
    tree['/workspace'] = [entry('old.txt'), entry('new.txt')]
    // Another session's tool wrote to the shared workspace.
    ;(ctx.emit as (...args: unknown[]) => void)('session/event', agentAt('/workspace', 'session-b').session, { type: 'tool/result' })
    // The stale index answers at once; its replacement is read in the background.
    expect(await service.list(agent, 'new', signal())).toEqual([])
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(await service.list(agent, 'new', signal())).toEqual([{ path: 'new.txt', kind: 'file' }])
    expect(paths()).toEqual(['/workspace', '/workspace'])
  })

  it('lists one directory for a query with a slash, relative or absolute inside the working directory', async () => {
    const { service, paths } = await provider({
      '/workspace/src': [entry('index.ts'), entry('lib', 'directory'), entry('dist', 'directory'), entry('.hidden')],
    })
    expect(await service.list(agentAt('/workspace/'), 'src/', signal())).toEqual([
      { path: 'src/lib', kind: 'directory' },
      { path: 'src/index.ts', kind: 'file' },
    ])
    expect(await service.list(agentAt('/workspace'), '/workspace/src/in', signal())).toEqual([
      { path: '/workspace/src/index.ts', kind: 'file' },
    ])
    expect(paths()).toEqual(['/workspace/src', '/workspace/src'])
  })

  it('returns no candidates for paths outside the working directory, excluded, or missing', async () => {
    const { service, paths } = await provider({ '/workspace': [entry('a.txt')] })
    for (const query of ['../', '/etc/', '/workspace-other/', 'node_modules/', 'missing/', 'bad"quote']) {
      expect(await service.list(agentAt('/workspace'), query, signal())).toEqual([])
    }
    expect(paths()).toEqual(['/workspace/missing'])
  })

  it('lists the working directory for an empty query, honors the result cap, and rejects cancelled reads', async () => {
    const { service } = await provider({
      '/workspace': [entry('c.txt'), entry('b.txt'), entry('a.txt')],
    }, { maxResults: 2 })
    expect(await service.list(agentAt(undefined), '', signal())).toEqual([
      { path: 'a.txt', kind: 'file' },
      { path: 'b.txt', kind: 'file' },
    ])
    await expect(service.list(agentAt(undefined), 'a', AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone')
  })

  it('installs the upstream file-reference guidance as a prompt section', async () => {
    const { ctx } = await provider({})
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(candidate => candidate.name === 'context:file-reference')
    expect(section?.text).toBe(FILE_REFERENCE_PROMPT)
  })
})

describe('file reference query helpers', () => {
  it('splits directory and fragment and normalizes backslashes', () => {
    expect(splitQuery('')).toEqual({ directory: '', fragment: '' })
    expect(splitQuery('src')).toEqual({ directory: '', fragment: 'src' })
    expect(splitQuery('src/li')).toEqual({ directory: 'src/', fragment: 'li' })
    expect(splitQuery('src\\lib\\')).toEqual({ directory: 'src/lib/', fragment: '' })
    expect(splitQuery('bad\u0000')).toBeUndefined()
  })

  it('resolves relative and absolute display directories inside the root only', () => {
    expect(resolveWithin('/workspace', '')).toBe('/workspace')
    expect(resolveWithin('/workspace/', './src/../lib/')).toBe('/workspace/lib')
    expect(resolveWithin('/workspace', 'src/../../')).toBeUndefined()
    expect(resolveWithin('/workspace', '/workspace/src/')).toBe('/workspace/src')
    expect(resolveWithin('/workspace', '/workspace/')).toBe('/workspace')
    expect(resolveWithin('/workspace', '/workspacex/')).toBeUndefined()
    expect(resolveWithin('/workspace', '/')).toBeUndefined()
    expect(resolveWithin('/', 'a/')).toBe('/a')
  })

  it('ranks exact, prefix, substring, path, and subsequence matches, directories first', () => {
    const ranked = rankCandidates([
      { path: 'zfoo.ts', kind: 'file' },
      { path: 'foo', kind: 'directory' },
      { path: 'foo.ts', kind: 'file' },
      { path: 'bar.ts', kind: 'file' },
      { path: 'Foobar', kind: 'directory' },
      { path: 'foo/bar.ts', kind: 'file' },
      { path: 'f/x/o/o.md', kind: 'file' },
    ], 'foo', 10)
    expect(ranked).toEqual([
      { path: 'foo', kind: 'directory' },
      { path: 'Foobar', kind: 'directory' },
      { path: 'foo.ts', kind: 'file' },
      { path: 'zfoo.ts', kind: 'file' },
      { path: 'foo/bar.ts', kind: 'file' },
      { path: 'f/x/o/o.md', kind: 'file' },
    ])
  })
})
