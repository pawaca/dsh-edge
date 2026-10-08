import type { SkillCandidate, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { describe, expect, it, vi } from 'vitest'
import * as EdgeWorkspaceSkills from '../src/edge-workspace-skills.ts'
import type { EdgeSkillFiles } from '../src/edge-workspace-skills.ts'

/** A Computer-workspace stand-in over a path → contents map; directories are implied by paths, and a file's mtime is its write count. */
function fakeFiles(tree: Record<string, string>, mtimes: Map<string, number> = new Map()): EdgeSkillFiles {
  const exists = (path: string) => Object.keys(tree).some(key => key === path || key.startsWith(`${path}/`))
  return {
    readdir: async (path, options) => {
      if (!exists(path) || path in tree) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
      const names = new Map<string, boolean>()
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(`${path}/`)) continue
        const [first, ...rest] = key.slice(path.length + 1).split('/')
        names.set(first!, rest.length === 0)
      }
      return [...names].sort(([a], [b]) => a.localeCompare(b)).slice(0, options?.limit).map(([name, isFile]) => {
        const full = `${path}/${name}`
        return { name, isFile, isDirectory: !isFile, size: isFile ? tree[full]!.length : 0, mtime: mtimes.get(full) ?? 0 }
      })
    },
    stat: async (path) => {
      if (!exists(path)) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
      return { size: tree[path]?.length ?? 0, mtime: mtimes.get(path) ?? 0, isFile: path in tree }
    },
    readFile: async (path) => {
      const value = tree[path]
      if (value === undefined) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
      const bytes = new TextEncoder().encode(value)
      // Small chunks, so a size limit is enforced while the stream is consumed.
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 4096) controller.enqueue(bytes.slice(i, i + 4096))
          controller.close()
        },
      })
    },
  }
}

const skill = (name: string, body: string, extra = '') => `---\nname: ${name}\ndescription: ${name} fixture\n${extra}---\n${body}\n`

function mount(tree: Record<string, string>) {
  const mtimes = new Map<string, number>()
  let factory: ((control: SkillProviderControl) => SkillProvider) | undefined
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const warn = vi.fn()
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    on: (name: string, handler: (...args: never[]) => unknown) => { handlers.set(name, handler); return () => {} },
    logger: { warn },
    skills: { registerProvider: (f: typeof factory) => { factory = f; return () => {} } },
  }
  const files = fakeFiles(tree, mtimes)
  let reads = 0
  let stats = 0
  /** Paths whose reads fail with a non-absence error, standing in for a transient storage fault. */
  const failing = new Set<string>()
  const counted: EdgeSkillFiles = {
    ...files,
    readFile: async (path) => {
      reads += 1
      if (failing.has(path)) throw Object.assign(new Error('storage busy'), { code: 'EIO' })
      return files.readFile(path)
    },
    stat: async (path) => { stats += 1; return files.stat(path) },
  }
  EdgeWorkspaceSkills.apply(ctx as never, { withFiles: read => read(counted) })
  const invalidate = vi.fn()
  const provider = factory!({ signal: new AbortController().signal, invalidate })
  const list = async (cwd: string) => (await provider.list({ cwd })) as SkillCandidate[]
  const write = (path: string, contents: string) => { tree[path] = contents; mtimes.set(path, (mtimes.get(path) ?? 0) + 1) }
  const sessions = new Map<string, { header: { cwd: string } }>()
  /** A turn starts, then its first step runs the pre-step waterfall the provider joins. */
  const startTurn = async (cwd: string) => {
    const session = sessions.get(cwd) ?? { header: { cwd } }
    sessions.set(cwd, session)
    const onEvent = handlers.get('session/event') as (session: unknown, event: { type: string }) => void
    const preStep = handlers.get('agent/pre-step') as (input: unknown, next: () => Promise<unknown>) => Promise<unknown>
    onEvent(session, { type: 'turn/start' })
    await preStep({ agent: { session }, signal: new AbortController().signal }, async () => ({ kind: 'enter' }))
  }
  return { provider, list, invalidate, warn, write, startTurn, failing, reads: () => reads, stats: () => stats }
}

describe('Edge workspace skills', () => {
  it('discovers bundle and flat skills from the project and user roots with upstream ranks', async () => {
    const { provider, list } = mount({
      '/workspace/proj/.git/HEAD': 'ref',
      '/workspace/proj/.dsh/skills/alpha/SKILL.md': skill('alpha', 'project dsh'),
      '/workspace/proj/.agents/skills/beta.md': skill('beta', 'project agents'),
      '/.dsh/skills/gamma/SKILL.md': skill('gamma', 'user dsh'),
      '/.dsh/skills/.system/SKILL.md': skill('hidden', 'system'),
      '/.agents/skills/delta.md': skill('delta', 'user agents'),
      '/workspace/proj/.dsh/skills/notes.txt': 'not a skill',
    })
    const candidates = await list('/workspace/proj/sub')
    expect(candidates.map(c => [c.name, c.rank, c.source])).toEqual([
      ['alpha', 100, 'project-dsh'],
      ['beta', 200, 'project-agents'],
      ['gamma', 400, 'user-dsh'],
      ['delta', 500, 'user-agents'],
    ])
    const alpha = candidates.find(c => c.name === 'alpha')!
    expect(alpha.provider).toBe('filesystem')
    expect(alpha.path).toBe('/workspace/proj/.dsh/skills/alpha/SKILL.md')
    const loaded = await provider.get(alpha, {})
    expect(loaded).toMatchObject({ name: 'alpha', content: 'project dsh', resourceBase: { kind: 'directory', path: '/workspace/proj/.dsh/skills/alpha' } })
  })

  it('uses the cwd as the project root when no ancestor holds .git', async () => {
    const { list } = mount({ '/workspace/.dsh/skills/root-skill/SKILL.md': skill('root-skill', 'body') })
    expect((await list('/workspace')).map(c => c.name)).toEqual(['root-skill'])
    expect(await list('/workspace/elsewhere')).toEqual([])
  })

  it('applies upstream invocation frontmatter and skips malformed files with a warning', async () => {
    const { list, warn } = mount({
      '/workspace/.dsh/skills/quiet/SKILL.md': skill('quiet', 'b', 'disable-model-invocation: yes\nuser-invocable: "off"\n'),
      '/workspace/.dsh/skills/bad-bool/SKILL.md': skill('bad-bool', 'b', 'user-invocable: maybe\n'),
      '/workspace/.dsh/skills/legacy/SKILL.md': skill('legacy', 'b', 'userInvocable: false\n'),
      '/workspace/.dsh/skills/no-desc/SKILL.md': '---\nname: no-desc\n---\nbody\n',
      '/workspace/.dsh/skills/BadName/SKILL.md': skill('BadName', 'b'),
      '/workspace/.dsh/skills/no-front/SKILL.md': 'just text\n',
    })
    const candidates = await list('/workspace')
    expect(candidates.map(c => [c.name, c.invocation])).toEqual([
      ['quiet', { modelInvocable: false, userInvocable: false }],
    ])
    expect(warn).toHaveBeenCalledTimes(5)
  })

  it('invalidates at a turn start only when the skill files changed, reading no contents when they did not', async () => {
    const { list, invalidate, write, startTurn, reads } = mount({ '/workspace/.dsh/skills/one/SKILL.md': skill('one', 'first') })
    await startTurn('/workspace')
    expect(invalidate).not.toHaveBeenCalled() // nothing cached for this cwd yet
    await list('/workspace')
    const readsAfterScan = reads()
    await startTurn('/workspace')
    expect(invalidate).not.toHaveBeenCalled()
    expect(reads()).toBe(readsAfterScan)
    write('/workspace/.dsh/skills/one/SKILL.md', skill('one', 'edited body'))
    await startTurn('/workspace')
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(reads()).toBe(readsAfterScan)
    await list('/workspace')
    write('/workspace/.dsh/skills/two.md', skill('two', 'added'))
    await startTurn('/workspace')
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('reads at most MAX_ENTRIES_PER_ROOT entries from a root, warning once per discovery', async () => {
    const tree: Record<string, string> = {}
    for (let i = 0; i < EdgeWorkspaceSkills.MAX_ENTRIES_PER_ROOT + 5; i += 1) {
      const name = `skill-${String(i).padStart(3, '0')}`
      tree[`/workspace/.dsh/skills/${name}.md`] = skill(name, 'b')
    }
    const { list, warn, startTurn } = mount(tree)
    expect(await list('/workspace')).toHaveLength(EdgeWorkspaceSkills.MAX_ENTRIES_PER_ROOT)
    expect(warn).toHaveBeenCalledTimes(1)
    await startTurn('/workspace')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('skips a skill file over MAX_SKILL_FILE_BYTES without reading it', async () => {
    const big = skill('big', 'x'.repeat(EdgeWorkspaceSkills.MAX_SKILL_FILE_BYTES))
    const { list, warn, reads } = mount({
      '/workspace/.dsh/skills/big/SKILL.md': big,
      '/workspace/.dsh/skills/small.md': skill('small', 'fits'),
    })
    expect((await list('/workspace')).map(c => c.name)).toEqual(['small'])
    expect(reads()).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds the 65536-byte limit'))
  })

  it('keeps at most MAX_FINGERPRINTS cwds, evicting the least recently used', async () => {
    const { list, invalidate, write, startTurn } = mount({ '/workspace/.dsh/skills/one/SKILL.md': skill('one', 'b') })
    await list('/workspace')
    for (let i = 0; i < EdgeWorkspaceSkills.MAX_FINGERPRINTS; i += 1) await list(`/workspace/p${String(i)}`)
    write('/workspace/.dsh/skills/one/SKILL.md', skill('one', 'changed'))
    await startTurn('/workspace')
    expect(invalidate).not.toHaveBeenCalled() // /workspace was evicted, so there is no cached catalog to refresh
    await startTurn('/workspace/p0')
    expect(invalidate).not.toHaveBeenCalled() // p0 has no skills under its own roots and the user roots did not change
  })

  it('enforces the byte limit while reading, even if a file grew after it was listed', async () => {
    const { provider, warn } = mount({ '/workspace/.dsh/skills/grow/SKILL.md': skill('grow', 'small') })
    const [candidate] = await provider.list({ cwd: '/workspace' }) as SkillCandidate[]
    expect(candidate?.name).toBe('grow')
    // The file grows after discovery: loading it reads past the limit and stops.
    const tree = { '/workspace/.dsh/skills/grow/SKILL.md': skill('grow', 'y'.repeat(EdgeWorkspaceSkills.MAX_SKILL_FILE_BYTES)) }
    const grown = fakeFiles(tree)
    let factory: ((control: SkillProviderControl) => SkillProvider) | undefined
    EdgeWorkspaceSkills.apply({
      effect: (fn: () => unknown) => fn(), on: () => () => {}, logger: { warn },
      skills: { registerProvider: (f: typeof factory) => { factory = f; return () => {} } },
    } as never, { withFiles: read => read(grown) })
    const loader = factory!({ signal: new AbortController().signal, invalidate: () => {} })
    expect(await loader.get(candidate!, {})).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds the 65536-byte limit'))
  })

  it('checks at most MAX_PROJECT_ROOT_DEPTH ancestors for .git', async () => {
    const { list, stats } = mount({})
    const deep = `/workspace/${Array.from({ length: 200 }, (_, i) => `d${String(i)}`).join('/')}`
    await list(deep)
    expect(stats()).toBeLessThanOrEqual(EdgeWorkspaceSkills.MAX_PROJECT_ROOT_DEPTH + 1)
  })

  it('skips a bundle whose SKILL.md is a directory, keeping the other skills', async () => {
    const { list } = mount({
      '/workspace/.dsh/skills/odd/SKILL.md/inner.txt': 'x',
      '/workspace/.dsh/skills/fine/SKILL.md': skill('fine', 'b'),
    })
    expect((await list('/workspace')).map(c => c.name)).toEqual(['fine'])
  })

  it('reports a catalog with an unreadable file as incomplete and records no fingerprint', async () => {
    const { provider, failing, invalidate, startTurn } = mount({
      '/workspace/.dsh/skills/flaky/SKILL.md': skill('flaky', 'b'),
      '/workspace/.dsh/skills/fine/SKILL.md': skill('fine', 'b'),
    })
    failing.add('/workspace/.dsh/skills/flaky/SKILL.md')
    const observed = await provider.list({ cwd: '/workspace' }) as { candidates: SkillCandidate[], complete: boolean }
    expect(observed.complete).toBe(false)
    expect(observed.candidates.map(c => c.name)).toEqual(['fine'])
    await startTurn('/workspace')
    expect(invalidate).not.toHaveBeenCalled() // nothing recorded, so the next lookup simply rescans
    failing.clear()
    expect((await provider.list({ cwd: '/workspace' }) as SkillCandidate[]).map(c => c.name)).toEqual(['fine', 'flaky'])
  })

  it('clears every fingerprint when a shared root change invalidates the registry', async () => {
    const { list, invalidate, write, startTurn } = mount({ '/.dsh/skills/shared/SKILL.md': skill('shared', 'b') })
    await list('/workspace/a')
    await list('/workspace/b')
    write('/.dsh/skills/shared/SKILL.md', skill('shared', 'changed'))
    await startTurn('/workspace/a')
    expect(invalidate).toHaveBeenCalledTimes(1)
    await startTurn('/workspace/b')
    expect(invalidate).toHaveBeenCalledTimes(1) // b's catalog was already cleared; it rebuilds on its next lookup
  })

  it('stops a scan whose lookup was cancelled', async () => {
    const { provider } = mount({ '/workspace/.dsh/skills/one/SKILL.md': skill('one', 'b') })
    const abort = new AbortController()
    abort.abort()
    await expect(provider.list({ cwd: '/workspace', signal: abort.signal })).rejects.toThrow()
  })
})
