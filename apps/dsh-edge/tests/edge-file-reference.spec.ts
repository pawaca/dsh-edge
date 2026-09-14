import { Context } from '@deepseek-ai/cordis'
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

function agentAt(cwd: string | undefined): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

async function provider(tree: Record<string, EdgeReferenceEntry[]>, maxResults?: number) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: 'test persona' })
  const reads: string[] = []
  await ctx.plugin(EdgeFileReferenceService, {
    ...(maxResults === undefined ? {} : { maxResults }),
    withFiles: read => read({
      readdir: (path: string) => {
        reads.push(path)
        const entries = tree[path]
        return entries === undefined
          ? Promise.reject(new Error(`ENOENT: ${path}`))
          : Promise.resolve(entries)
      },
    }),
  })
  return { ctx, reads, service: ctx.fileReferences }
}

describe('EdgeFileReferenceService', () => {
  it('lists the session working directory for a bare fragment', async () => {
    const { service, reads } = await provider({
      '/workspace': [entry('src', 'directory'), entry('README.md'), entry('.env'), entry('release.txt')],
    })
    const candidates = await service.list(agentAt('/workspace'), 're', AbortSignal.timeout(1_000))
    expect(candidates).toEqual([
      { path: 'README.md', kind: 'file' },
      { path: 'release.txt', kind: 'file' },
    ])
    expect(reads).toEqual(['/workspace'])
  })

  it('descends into the directory a slash names and keeps the display prefix', async () => {
    const { service, reads } = await provider({
      '/workspace/src': [entry('index.ts'), entry('lib', 'directory'), entry('.hidden')],
    })
    const candidates = await service.list(agentAt('/workspace/'), 'src/', AbortSignal.timeout(1_000))
    expect(candidates).toEqual([
      { path: 'src/lib', kind: 'directory' },
      { path: 'src/index.ts', kind: 'file' },
    ])
    expect(reads).toEqual(['/workspace/src'])
  })

  it('returns no candidates for paths that escape the working directory or do not exist', async () => {
    const { service, reads } = await provider({ '/workspace': [entry('a.txt')] })
    const signal = AbortSignal.timeout(1_000)
    expect(await service.list(agentAt('/workspace'), '../', signal)).toEqual([])
    expect(await service.list(agentAt('/workspace'), 'missing/', signal)).toEqual([])
    expect(await service.list(agentAt('/workspace'), 'bad"quote', signal)).toEqual([])
    expect(reads).toEqual(['/workspace/missing'])
  })

  it('defaults to /workspace, honors the result cap, and rejects cancelled reads', async () => {
    const { service } = await provider({
      '/workspace': [entry('c.txt'), entry('b.txt'), entry('a.txt')],
    }, 2)
    expect(await service.list(agentAt(undefined), '', AbortSignal.timeout(1_000))).toEqual([
      { path: 'a.txt', kind: 'file' },
      { path: 'b.txt', kind: 'file' },
    ])
    await expect(service.list(agentAt(undefined), '', AbortSignal.abort(new Error('gone'))))
      .rejects.toThrow('gone')
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

  it('resolves display directories inside the root only', () => {
    expect(resolveWithin('/workspace', '')).toBe('/workspace')
    expect(resolveWithin('/workspace/', './src/../lib/')).toBe('/workspace/lib')
    expect(resolveWithin('/workspace', 'src/../../')).toBeUndefined()
    expect(resolveWithin('/', 'a/')).toBe('/a')
  })

  it('ranks exact, prefix, and substring matches with directories first', () => {
    const ranked = rankCandidates([
      entry('zfoo.ts'),
      entry('foo', 'directory'),
      entry('foo.ts'),
      entry('bar.ts'),
      entry('Foobar', 'directory'),
      entry('.foo'),
    ], { directory: 'x/', fragment: 'foo' }, 10)
    expect(ranked).toEqual([
      { path: 'x/foo', kind: 'directory' },
      { path: 'x/Foobar', kind: 'directory' },
      { path: 'x/foo.ts', kind: 'file' },
      { path: 'x/zfoo.ts', kind: 'file' },
    ])
  })
})
