import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  assembleReference,
  checkWiki,
  classifyDocsDiff,
  collectEdgeUsage,
  mentionsUsedPackage,
  mergePlugins,
  parseComposition,
  parseToolCatalog,
  untar,
  validateManifest,
  verifyParity,
} from './upstream-parity.mjs'

const composition = `# a reference composition
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are helpful.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
- id: delegation
  name: cordis:group
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true # opt in per deployment
`

function reference(overrides = {}) {
  return {
    upstreamVersion: '1.0.0',
    plugins: {
      '@deepseek-ai/dsh-used': { in: ['dsh-base'], disabled: false },
      '@deepseek-ai/dsh-gap': { in: ['dsh-base'], disabled: false },
      '@deepseek-ai/dsh-off': { in: ['dsh-base'], disabled: true },
    },
    tools: { '@deepseek-ai/dsh-tool-extra': ['extra'] },
    subsystems: ['alpha', 'beta'],
    ...overrides,
  }
}

const usage = collectEdgeUsage([`import Used from '@deepseek-ai/dsh-used'`], [])

describe('upstream parity', () => {
  it('reads composition rows, nested groups, and Workers platform gates', () => {
    expect(parseComposition(composition)).toEqual([
      { name: '@deepseek-ai/dsh-persona', disabled: false },
      { name: '@deepseek-ai/dsh-tool-bash', disabled: false },
      { name: '@deepseek-ai/dsh-tool-pwsh', disabled: true },
      { name: '@deepseek-ai/dsh-tool-subagent-control', disabled: false },
      { name: '@deepseek-ai/dsh-tool-subagent', disabled: true },
    ])
  })

  it('reads every valid YAML spelling of a row', () => {
    const spellings = [
      "- { id: flow, name: '@deepseek-ai/dsh-flow' }",
      "- id: spaced\n  name : '@deepseek-ai/dsh-spaced'",
      '- id: quoted\n  "name": "@deepseek-ai/dsh-quoted"',
      '- id: folded\n  name: >-\n    @deepseek-ai/dsh-folded',
      "- id: twice\n  name: '@deepseek-ai/dsh-flow'\n  disabled: true",
      "# - id: old\n#   name: '@deepseek-ai/dsh-old'",
    ].join('\n')
    expect(parseComposition(spellings)).toEqual([
      { name: '@deepseek-ai/dsh-flow', disabled: false },
      { name: '@deepseek-ai/dsh-spaced', disabled: false },
      { name: '@deepseek-ai/dsh-quoted', disabled: false },
      { name: '@deepseek-ai/dsh-folded', disabled: false },
      { name: '@deepseek-ai/dsh-flow', disabled: true },
    ])
  })

  it('rejects a disabled expression it cannot evaluate, including an extended platform gate', () => {
    for (const gate of ['process.env.X', "process.platform !== 'win32' && process.env.FEATURE"]) {
      expect(() => parseComposition(`- id: x\n  name: '@deepseek-ai/dsh-x'\n  disabled: !!js ${gate}\n`))
        .toThrow(/unrecognized disabled expression/u)
    }
  })

  it('keeps a plugin enabled when any composition enables it', () => {
    const plugins = mergePlugins([
      { source: 'preset:standard', rows: [{ name: '@deepseek-ai/dsh-tool-subagent', disabled: false }] },
      { source: 'preset:ptc', rows: [{ name: '@deepseek-ai/dsh-tool-subagent', disabled: true }] },
      { source: 'dsh-base', rows: [{ name: '@deepseek-ai/dsh-skill-badge', disabled: true }] },
    ])
    expect(plugins['@deepseek-ai/dsh-tool-subagent']).toEqual({ in: ['preset:standard', 'preset:ptc'], disabled: false })
    expect(plugins['@deepseek-ai/dsh-skill-badge'].disabled).toBe(true)
  })

  it('refuses a reference input that parses to nothing', () => {
    const compositions = [
      { package: 'dsh-base', path: 'cordis.patch.yml', text: composition },
      { package: 'dsh-base', path: 'README.i18n.yaml', text: 'not a composition' },
      { package: 'dsh-web-app', path: 'cordis.patch.yml', text: composition },
      { package: 'dsh-agent-presets', path: 'presets/standard/agent.cordis.yml', text: composition },
      { package: 'dsh-agent-presets', path: 'presets/standard/preset.yml', text: 'name: Standard' },
    ]
    const input = {
      version: '1.0.0',
      compositions,
      toolCatalog: '| `@deepseek-ai/dsh-tool-todo` | `todo_write` | `ctx.tools` |\n\n## `@deepseek-ai/dsh-tool-todo`\n',
      docsPaths: ['docs/subsystems/todo.md', 'docs/subsystems/README.md'],
    }
    expect(assembleReference(input)).toMatchObject({ subsystems: ['todo'], tools: { '@deepseek-ai/dsh-tool-todo': ['todo_write'] } })
    const reshaped = compositions.map((file, index) => index === 2 ? { ...file, text: 'plugins:\n  persona: {}\n' } : file)
    expect(() => assembleReference({ ...input, compositions: reshaped })).toThrow(/dsh-web-app@1\.0\.0 cordis\.patch\.yml parsed to no plugins/u)
    expect(() => assembleReference({ ...input, compositions: compositions.slice(0, 3) })).toThrow(/dsh-agent-presets@1\.0\.0 has no reference composition/u)
    // One preset moves while another stays: both the stray composition and the orphaned preset fail.
    const moved = [...compositions,
      { package: 'dsh-agent-presets', path: 'presets/ptc/composition/agent.cordis.yml', text: composition },
      { package: 'dsh-agent-presets', path: 'presets/ptc/preset.yml', text: 'name: PTC' }]
    expect(() => assembleReference({ ...input, compositions: moved })).toThrow(/ships presets\/ptc\/composition\/agent\.cordis\.yml, which REFERENCE_SOURCES does not read/u)
    const orphaned = [...compositions, { package: 'dsh-agent-presets', path: 'presets/ptc/preset.yml', text: 'name: PTC' }]
    expect(() => assembleReference({ ...input, compositions: orphaned })).toThrow(/presets\/ptc\/preset\.yml has no matched composition beside it/u)
    expect(() => assembleReference({ ...input, toolCatalog: '# renamed table' })).toThrow(/parsed to no packages/u)
    expect(() => assembleReference({ ...input, docsPaths: [] })).toThrow(/lists no docs\/subsystems pages/u)
  })

  it('maps tool-catalog packages to their tools, cross-checked against their sections', () => {
    const catalog = [
      '| Package | Tools | Needs |',
      '| --- | --- | --- |',
      '| `@deepseek-ai/dsh-tool-todo` | `todo_write` | `ctx.tools` |',
      '| `@deepseek-ai/dsh-tool-fs-search` | `glob`, `grep` | `ctx.subprocess` |',
      '',
      '## `@deepseek-ai/dsh-tool-todo`',
      '## `@deepseek-ai/dsh-tool-fs-search`',
    ]
    expect(parseToolCatalog(catalog.join('\n'))).toEqual({
      '@deepseek-ai/dsh-tool-todo': ['todo_write'],
      '@deepseek-ai/dsh-tool-fs-search': ['glob', 'grep'],
    })
    // One row reformatted while the other still parses.
    const linked = catalog.map(line => line.replace('| `@deepseek-ai/dsh-tool-fs-search` |', '| [`@deepseek-ai/dsh-tool-fs-search`](x) |'))
    expect(() => parseToolCatalog(linked.join('\n'))).toThrow(/unreadable tool-catalog rows/u)
    // One row dropped, or one section without a row, or a row without a section.
    expect(() => parseToolCatalog(catalog.filter(line => !line.startsWith('| `@deepseek-ai/dsh-tool-fs-search`')).join('\n')))
      .toThrow(/no row: @deepseek-ai\/dsh-tool-fs-search; no section: none/u)
    expect(() => parseToolCatalog(catalog.filter(line => line !== '## `@deepseek-ai/dsh-tool-todo`').join('\n')))
      .toThrow(/no row: none; no section: @deepseek-ai\/dsh-tool-todo/u)
  })

  it('counts runtime imports and the boot graph, not type-only imports, comments, or strings', () => {
    const found = collectEdgeUsage([
      `import type { A } from '@deepseek-ai/dsh-types-only'`,
      `import { type B, type C } from '@deepseek-ai/dsh-named-types'`,
      `import * as Fs from '@deepseek-ai/dsh-tool-fs'`,
      `const { X } = await import('@deepseek-ai/dsh-lazy/sub')`,
      `const { TYPERT } = await import('@deepseek-ai/dsh-cast/typert' as string)`,
      `// import Removed from '@deepseek-ai/dsh-commented-out'`,
      `const text = "import Nope from '@deepseek-ai/dsh-in-a-string'"`,
      `/* await import('@deepseek-ai/dsh-block-comment') */`,
    ], [{ id: '@deepseek-ai/dsh-client-ui-chat' }])
    expect([...found.packages].sort()).toEqual([
      '@deepseek-ai/dsh-cast',
      '@deepseek-ai/dsh-client-ui-chat',
      '@deepseek-ai/dsh-lazy',
      '@deepseek-ai/dsh-tool-fs',
    ])
    expect(found.specifiers.has('@deepseek-ai/dsh-lazy/sub')).toBe(true)
  })

  it('passes when every required entry is used or classified', () => {
    const result = verifyParity({
      upstreamVersion: '1.0.0',
      reference: reference(),
      usage,
      manifest: { packages: {
        '@deepseek-ai/dsh-gap': { status: 'gap', reason: 'not ported yet' },
        '@deepseek-ai/dsh-tool-extra': { status: 'tracked', reason: 'tracked', issue: 7 },
      } },
    })
    expect(result.errors).toEqual([])
    expect(result.counts).toEqual({ used: 1, gap: 1, tracked: 1 })
  })

  it('reports unclassified, stale, and malformed entries and a baseline mismatch', () => {
    const { errors } = verifyParity({
      upstreamVersion: '2.0.0',
      reference: reference(),
      usage,
      manifest: { packages: {
        '@deepseek-ai/dsh-used': { status: 'substitute', reason: 'stale' },
        '@deepseek-ai/dsh-tool-extra': { status: 'tracked', reason: 'no issue' },
        '@deepseek-ai/dsh-gone': { status: 'declined', reason: 'removed upstream' },
        '@deepseek-ai/dsh-off': { status: 'maybe', reason: '' },
      } },
    })
    expect(errors).toEqual([
      expect.stringMatching(/describes 1\.0\.0, but the baseline is 2\.0\.0/u),
      expect.stringMatching(/dsh-used is used by the Edge/u),
      expect.stringMatching(/dsh-gap \(dsh-base\) is not used by the Edge and not classified/u),
      expect.stringMatching(/dsh-gone is not required by the upstream reference/u),
      expect.stringMatching(/dsh-off is not required by the upstream reference/u),
      expect.stringMatching(/dsh-tool-extra is tracked but names no issue/u),
      expect.stringMatching(/dsh-off has unknown status "maybe"/u),
      expect.stringMatching(/dsh-off needs a reason/u),
    ])
  })

  it('validates every manifest field in one place', () => {
    expect(validateManifest({
      packages: {
        '@deepseek-ai/ok-tracked': { status: 'tracked', reason: 'x', issue: 99 },
        '@deepseek-ai/ok-gap': { status: 'gap', reason: 'x', priority: 'P1', issue: 234 },
        '@deepseek-ai/zero': { status: 'tracked', reason: 'x', issue: 0 },
        '@deepseek-ai/negative': { status: 'gap', reason: 'x', issue: -3 },
        '@deepseek-ai/text-issue': { status: 'tracked', reason: 'x', issue: '99' },
        '@deepseek-ai/bad-priority': { status: 'gap', reason: 'x', priority: 'high' },
        '@deepseek-ai/priority-off-gap': { status: 'declined', reason: 'x', priority: 'P2' },
        '@deepseek-ai/typo': { status: 'declined', reason: 'x', isue: 5 },
      },
      wikiOmit: { alpha: 'internal only' },
    })).toEqual([
      '@deepseek-ai/zero names an invalid issue 0.',
      '@deepseek-ai/negative names an invalid issue -3.',
      '@deepseek-ai/text-issue names an invalid issue "99".',
      '@deepseek-ai/bad-priority has priority "high"; only gap entries take P1, P2, or P3.',
      '@deepseek-ai/priority-off-gap has priority "P2"; only gap entries take P1, P2, or P3.',
      '@deepseek-ai/typo has unknown field "isue".',
    ])
  })

  it('expires the classification of a plugin upstream now disables everywhere', () => {
    const { errors } = verifyParity({ upstreamVersion: '1.0.0', reference: reference(), usage, manifest: { packages: {
      '@deepseek-ai/dsh-gap': { status: 'gap', reason: 'x' },
      '@deepseek-ai/dsh-tool-extra': { status: 'declined', reason: 'x' },
      '@deepseek-ai/dsh-off': { status: 'declined', reason: 'was enabled in an older baseline' },
    } } })
    expect(errors).toEqual([expect.stringMatching(/^@deepseek-ai\/dsh-off is not required by the upstream reference/u)])
  })

  it('never takes an Object.prototype name for a status, entry, or reason', () => {
    const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty']
    expect(validateManifest({ packages: Object.fromEntries(inherited.map(status =>
      [`@deepseek-ai/${status}`, { status, reason: 'x' }])) })).toEqual(inherited.map(status =>
      `@deepseek-ai/${status} has unknown status "${status}".`))
    const prototypeSlugs = reference({ subsystems: ['constructor', 'toString'] })
    expect(checkWiki({ reference: prototypeSlugs, manifest: { packages: {} }, pages: [] }).missing).toEqual(['constructor', 'toString'])
    const { errors } = verifyParity({ upstreamVersion: '1.0.0', reference: reference({ plugins: {}, tools: { constructor: ['x'] } }), usage, manifest: { packages: {} } })
    expect(errors).toEqual([expect.stringMatching(/^constructor \(tool-catalog\) is not used by the Edge and not classified/u)])
  })

  it('requires a wiki page or an omission reason per upstream subsystem', () => {
    const pages = ['Upstream reference: [Alpha](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/alpha)']
    expect(checkWiki({ reference: reference(), manifest: { packages: {} }, pages })).toEqual({ missing: ['beta'], staleOmissions: [] })
    expect(checkWiki({ reference: reference(), manifest: { packages: {}, wikiOmit: { beta: 'internal', gamma: 'gone' } }, pages }))
      .toEqual({ missing: [], staleOmissions: ['gamma'] })
    expect(checkWiki({ reference: reference(), manifest: { packages: {}, wikiOmit: { beta: ' ' } }, pages }).missing).toEqual(['beta'])
    // Mentions that are not links to the upstream page do not count.
    const mentions = [
      '- [ ] write a page for docs/subsystems/beta',
      '```\n[Beta](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/beta)\n```',
      '[Beta](https://example.com/subsystems/beta)',
    ]
    expect(checkWiki({ reference: reference(), manifest: { packages: {} }, pages: [...pages, ...mentions] }).missing).toEqual(['beta'])
    const repoLink = '[Beta](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v1.0.0/docs/subsystems/beta.md)'
    expect(checkWiki({ reference: reference(), manifest: { packages: {} }, pages: [...pages, repoLink] }).missing).toEqual([])
    const { errors } = verifyParity({ upstreamVersion: '1.0.0', reference: reference(), usage, manifest: { packages: {
      '@deepseek-ai/dsh-gap': { status: 'gap', reason: 'x' },
      '@deepseek-ai/dsh-tool-extra': { status: 'declined', reason: 'x' },
    }, wikiOmit: { beta: '' } } })
    expect(errors).toEqual([expect.stringMatching(/wikiOmit "beta" needs a reason/u)])
  })

  it('sorts upstream docs changes into review buckets', () => {
    const fromTree = new Map([
      ['docs/subsystems/shell.md', 'a'],
      ['docs/subsystems/code-runtime.md', 'b'],
      ['docs/subsystems/todo.md', 'c'],
      ['docs/tool-catalog.md', 'd'],
      ['docs/glossary.md', 'e'],
      ['docs/subsystems/todo.zh.md', 'f'],
    ])
    const toTree = new Map([
      ['docs/subsystems/shell.md', 'a2'],
      ['docs/subsystems/todo.md', 'c2'],
      ['docs/subsystems/ptc-runtime.md', 'g'],
      ['docs/tool-catalog.md', 'd2'],
      ['docs/glossary.md', 'e2'],
      ['docs/subsystems/todo.zh.md', 'f2'],
    ])
    expect(classifyDocsDiff({ fromTree, toTree, relevant: path => path.endsWith('/shell.md') })).toEqual({
      subsystemsAdded: ['ptc-runtime'],
      subsystemsRemoved: ['code-runtime'],
      catalogs: ['docs/tool-catalog.md'],
      edgeSubsystems: ['docs/subsystems/shell.md'],
      other: ['docs/glossary.md', 'docs/subsystems/todo.md'],
    })
  })

  it('treats a subsystem page as Edge-relevant when either version names a used package', () => {
    const before = 'Owned by `@deepseek-ai/dsh-used`.'
    const after = 'Moved to a new package, `@deepseek-ai/dsh-renamed`.'
    expect(mentionsUsedPackage([before, after], usage)).toBe(true)
    expect(mentionsUsedPackage(['', after], usage)).toBe(false)
  })

  it('reads regular files from an npm tarball', () => {
    const entry = (name, body) => {
      const header = Buffer.alloc(512)
      header.write(name, 0)
      header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
      header.write('0', 156)
      const data = Buffer.alloc(Math.ceil(body.length / 512) * 512)
      data.write(body)
      return Buffer.concat([header, data])
    }
    const tarball = gzipSync(Buffer.concat([
      entry('package/cordis.patch.yml', '- id: a\n'),
      entry('package/presets/standard/agent.cordis.yml', '- id: b\n'),
      Buffer.alloc(1024),
    ]))
    expect(Object.fromEntries(untar(tarball))).toEqual({
      'cordis.patch.yml': '- id: a\n',
      'presets/standard/agent.cordis.yml': '- id: b\n',
    })
  })
})
