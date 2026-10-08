import type { SkillCandidate, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { describe, expect, it, vi } from 'vitest'
import * as EdgeWorkspaceSkills from '../src/edge-workspace-skills.ts'
import type { EdgeSkillFiles } from '../src/edge-workspace-skills.ts'

/** A Computer-workspace stand-in over a path → contents map; directories are implied by paths. */
function fakeFiles(tree: Record<string, string>): EdgeSkillFiles {
  const exists = (path: string) => Object.keys(tree).some(key => key === path || key.startsWith(`${path}/`))
  return {
    readdir: async (path) => {
      if (!exists(path) || path in tree) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
      const names = new Map<string, boolean>()
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(`${path}/`)) continue
        const [first, ...rest] = key.slice(path.length + 1).split('/')
        names.set(first!, rest.length === 0)
      }
      return [...names].map(([name, isFile]) => ({ name, isFile, isDirectory: !isFile }))
    },
    stat: async (path) => {
      if (!exists(path)) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
      return {}
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
  let factory: ((control: SkillProviderControl) => SkillProvider) | undefined
  const handlers: ((session: unknown, event: { type: string }) => void)[] = []
  const warn = vi.fn()
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    on: (_name: string, handler: (session: unknown, event: { type: string }) => void) => { handlers.push(handler); return () => {} },
    logger: { warn },
    skills: { registerProvider: (f: typeof factory) => { factory = f; return () => {} } },
  }
  const files = fakeFiles(tree)
  EdgeWorkspaceSkills.apply(ctx as never, { withFiles: read => read(files) })
  const invalidate = vi.fn()
  const provider = factory!({ signal: new AbortController().signal, invalidate })
  const list = async (cwd: string) => (await provider.list({ cwd })) as SkillCandidate[]
  return { provider, list, invalidate, warn, emit: (type: string) => { for (const h of handlers) h({}, { type }) } }
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

  it('refreshes the catalog when a turn starts, not on every lookup', () => {
    const { invalidate, emit } = mount({})
    emit('step/start')
    expect(invalidate).not.toHaveBeenCalled()
    emit('turn/start')
    expect(invalidate).toHaveBeenCalledTimes(1)
  })
})
