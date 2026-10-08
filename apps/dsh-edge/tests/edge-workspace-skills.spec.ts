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
      return { size: tree[path]?.length ?? 0, mtime: mtimes.get(path) ?? 0 }
    },
    readFile: async (path) => {
      const value = tree[path]
      if (value === undefined) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
      return value
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
  const counted: EdgeSkillFiles = { ...files, readFile: async (path, encoding) => { reads += 1; return files.readFile(path, encoding) } }
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
  return { provider, list, invalidate, warn, write, startTurn, reads: () => reads }
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

  it('stops a scan whose lookup was cancelled', async () => {
    const { provider } = mount({ '/workspace/.dsh/skills/one/SKILL.md': skill('one', 'b') })
    const abort = new AbortController()
    abort.abort()
    await expect(provider.list({ cwd: '/workspace', signal: abort.signal })).rejects.toThrow()
  })
})
