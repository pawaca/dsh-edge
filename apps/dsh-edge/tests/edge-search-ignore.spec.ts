import { describe, expect, it } from 'vitest'
import { IgnoreRules, IgnoreStack, parseIgnoreRules, ripgrepBraces, ruleMatcherCount } from '../src/edge-search-ignore.ts'

describe('ignore file rules', () => {
  it('parses comments, escapes, negation, anchoring, and directory-only patterns', () => {
    expect(parseIgnoreRules('# note\n\n\\#hash\n\\!bang\n!keep\n/root\nsub/dir/\nname/\ntrail\\ \nspace   \r\n')).toEqual([
      { glob: '#hash', negate: false, dirOnly: false, basename: true },
      { glob: '!bang', negate: false, dirOnly: false, basename: true },
      { glob: 'keep', negate: true, dirOnly: false, basename: true },
      { glob: 'root', negate: false, dirOnly: false, basename: false },
      { glob: 'sub/dir', negate: false, dirOnly: true, basename: false },
      { glob: 'name', negate: false, dirOnly: true, basename: true },
      { glob: 'trail ', negate: false, dirOnly: false, basename: true },
      { glob: 'space', negate: false, dirOnly: false, basename: true },
    ])
  })

  it('lets the last matching rule decide', () => {
    const rules = new IgnoreRules('*.log\n!keep.log\nkeep.log\n!*.tmp.log\n')
    expect(rules.match('a/debug.log', false)).toBe('ignore')
    expect(rules.match('keep.log', false)).toBe('ignore')
    expect(rules.match('x.tmp.log', false)).toBe('whitelist')
    expect(rules.match('a.ts', false)).toBeUndefined()
  })

  it('matches a slashless pattern at any depth and an anchored one from its directory', () => {
    const rules = new IgnoreRules('dist\n/top.txt\nsrc/*.gen.ts\ndocs/**/draft.md\nout/**\n')
    expect(rules.match('a/b/dist', true)).toBe('ignore')
    expect(rules.match('top.txt', false)).toBe('ignore')
    expect(rules.match('a/top.txt', false)).toBeUndefined()
    expect(rules.match('src/x.gen.ts', false)).toBe('ignore')
    expect(rules.match('src/a/x.gen.ts', false)).toBeUndefined()
    expect(rules.match('docs/draft.md', false)).toBe('ignore')
    expect(rules.match('docs/a/b/draft.md', false)).toBe('ignore')
    // `out/**` matches inside the directory, not the directory itself.
    expect(rules.match('out', true)).toBeUndefined()
    expect(rules.match('out/a.js', false)).toBe('ignore')
  })

  it('applies a directory-only pattern to directories, not to files of that name', () => {
    const rules = new IgnoreRules('build/\n')
    expect(rules.match('build', true)).toBe('ignore')
    expect(rules.match('build', false)).toBeUndefined()
    expect(rules.match('pkg/build', true)).toBe('ignore')
  })

  it('compiles each rule once, not once per tested path', () => {
    const rules = new IgnoreRules(Array.from({ length: 500 }, (_, index) => `pattern-${String(index)}-*.tmp`).join('\n'))
    const started = performance.now()
    for (let index = 0; index < 2_000; index++) rules.match(`dir/file-${String(index)}.ts`, false)
    // One million rule tests; recompiling each glob per test took over ten seconds.
    expect(performance.now() - started).toBeLessThan(8_000)
  }, 30_000)

  it('reads braces as ripgrep does: comma alternatives only', () => {
    expect(ripgrepBraces('*.{js,ts}')).toBe('*.{js,ts}')
    expect(ripgrepBraces('{1..3}')).toBe('1..3')
    expect(ripgrepBraces('a{b}c')).toBe('abc')
    expect(ripgrepBraces('ab{,c}')).toBe('abc')
    expect(ripgrepBraces('ab{c,}')).toBe('abc')
    expect(ripgrepBraces('a{,b,,c}')).toBe('a{b,c}')
    expect(ripgrepBraces('a{,}')).toBeUndefined()
    // Braces inside a character class are members, not a group.
    expect(ripgrepBraces('[{}]')).toBe('[{}]')
    expect(ripgrepBraces('[]{]x{a,}')).toBe('[]{]xa')
    expect(new IgnoreRules('[{}]\n').match('}', false)).toBe('ignore')
    expect(ripgrepBraces('x\\{1..3\\}')).toBe('x\\{1..3\\}')
    const rules = new IgnoreRules('{1..3}\nab{,c}\n*.{tmp,bak}\n')
    expect(rules.match('2', false)).toBeUndefined()
    expect(rules.match('1..3', false)).toBe('ignore')
    expect(rules.match('ab', false)).toBeUndefined()
    expect(rules.match('abc', false)).toBe('ignore')
    expect(rules.match('x.bak', false)).toBe('ignore')
  })

  it('counts the matchers a rule\'s brace alternates expand to, without expanding them', () => {
    expect(ruleMatcherCount({ glob: '*.log' })).toBe(1)
    expect(ruleMatcherCount({ glob: '*.{js,ts,tsx}' })).toBe(3)
    expect(ruleMatcherCount({ glob: '{a,b}{c,d}' })).toBe(4)
    expect(ruleMatcherCount({ glob: 'x\\{a,b\\}' })).toBe(1)
    // Sixteen groups would be 65,536 matchers; the count stops once past its limit.
    expect(ruleMatcherCount({ glob: '{a,b}'.repeat(16) })).toBe(65_536)
    expect(ruleMatcherCount({ glob: '{a,b}'.repeat(16) }, 5_000)).toBeLessThan(65_536)
    expect(ruleMatcherCount({ glob: '{a,b}'.repeat(16) }, 5_000)).toBeGreaterThan(5_000)
  })

  it('tests the entry itself, never its parents', () => {
    const rules = new IgnoreRules('vendor\n')
    expect(rules.match('vendor', true)).toBe('ignore')
    expect(rules.match('vendor/a.js', false)).toBeUndefined()
  })
})

describe('ignore precedence', () => {
  const frame = (dir: string, files: Record<string, string>, hasGit = false) => ({
    dir,
    hasGit,
    files: Object.fromEntries(Object.entries(files).map(([kind, text]) => [kind, new IgnoreRules(text)])),
  })

  it('prefers a deeper match within a kind and any .rgignore or .ignore match over .gitignore', () => {
    const stack = IgnoreStack.empty()
      .push(frame('/w', { gitignore: '*.ts\n', ignore: '!keep.ts\n' }, true))
      .push(frame('/w/pkg', { gitignore: '!*.ts\n', rgignore: 'secret.ts\n' }))
    expect(stack.decide('/w/pkg/a.ts', false)).toBe('whitelist')
    expect(stack.decide('/w/a.ts', false)).toBe('ignore')
    expect(stack.decide('/w/pkg/secret.ts', false)).toBe('ignore')
    expect(stack.decide('/w/pkg/keep.ts', false)).toBe('whitelist')
  })

  it('ignores .gitignore outside a repository and above its root', () => {
    const outside = IgnoreStack.empty().push(frame('/w', { gitignore: 'a\n' }))
    expect(outside.decide('/w/a', false)).toBeUndefined()
    const nested = IgnoreStack.empty()
      .push(frame('/w', { gitignore: 'a\n' }))
      .push(frame('/w/repo', { gitignore: 'b\n' }, true))
    expect(nested.decide('/w/repo/a', false)).toBeUndefined()
    expect(nested.decide('/w/repo/b', false)).toBe('ignore')
  })
})
