/**
 * ripgrep's default ignore rules for the Edge `grep` walk.
 *
 * Upstream's `grep` runs ripgrep without `--no-ignore`, so `.rgignore`,
 * `.ignore`, and (inside a git repository) `.gitignore` files decide what it
 * searches; upstream's `glob` passes `--no-ignore --hidden` and is unaffected.
 * This module mirrors the `ignore` crate's precedence:
 *
 * - each file's rules apply to paths relative to its directory, and its last
 *   matching rule wins (a `!` rule re-includes);
 * - a match in a deeper directory beats one in a shallower directory;
 * - across kinds, any `.rgignore` match beats any `.ignore` match, which beats
 *   any `.gitignore` match, whatever their depths;
 * - `.gitignore` applies only when a `.git` entry exists at or above the
 *   search root, and not from directories above the repository root;
 * - a rule tests the entry itself, never its parents: the walk prunes an
 *   ignored directory, and a search rooted inside one still searches it, as
 *   ripgrep does for an explicit path.
 *
 * Global gitignore files and `.git/info/exclude` are not read.
 */
import { Minimatch } from 'minimatch'

export type IgnoreKind = 'rgignore' | 'ignore' | 'gitignore'
export type IgnoreMatch = 'ignore' | 'whitelist'

/** Ignore file names in precedence order, highest first. */
export const IGNORE_FILES: ReadonlyArray<readonly [name: string, kind: IgnoreKind]> = [
  ['.rgignore', 'rgignore'],
  ['.ignore', 'ignore'],
  ['.gitignore', 'gitignore'],
]
const KINDS: readonly IgnoreKind[] = IGNORE_FILES.map(([, kind]) => kind)

export interface IgnoreRule {
  readonly glob: string
  readonly negate: boolean
  readonly dirOnly: boolean
  /** A pattern with no `/` but a trailing one matches the basename at any depth. */
  readonly basename: boolean
}

/** One ignore file's rules, matched against paths relative to its directory. */
export class IgnoreRules {
  // Compiled once: the walk tests every entry against every rule.
  private readonly rules: ReadonlyArray<IgnoreRule & { readonly matcher: Minimatch }>

  /** @param source - an ignore file's text, or its rules already parsed (to count them first). */
  constructor(source: string | readonly IgnoreRule[]) {
    const rules = typeof source === 'string' ? parseIgnoreRules(source) : source
    this.rules = rules.map(rule => ({ ...rule, matcher: new Minimatch(rule.glob, MATCH_OPTIONS) }))
  }

  get empty(): boolean {
    return this.rules.length === 0
  }

  /** The last rule matching `relativePath`, as ripgrep reads it. */
  match(relativePath: string, isDir: boolean): IgnoreMatch | undefined {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
    for (let index = this.rules.length - 1; index >= 0; index--) {
      const rule = this.rules[index]!
      if (rule.dirOnly && !isDir) continue
      if (rule.matcher.match(rule.basename ? name : relativePath)) {
        return rule.negate ? 'whitelist' : 'ignore'
      }
    }
    return undefined
  }
}

// dot: `*` matches dotfiles in ignore files; noext: no extglobs; braces stay
// alternates, as ripgrep's globset reads them.
const MATCH_OPTIONS = { dot: true, noext: true, nocomment: true, nonegate: true } as const

/** Parse gitignore syntax: comments, `\` escapes, `!` negation, `/` anchoring, trailing `/`. */
export function parseIgnoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    line = trimTrailingSpaces(line)
    if (line === '' || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/') && !line.endsWith('\\/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (line === '') continue
    // A `/` anywhere but the end anchors the pattern to the file's directory.
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (line === '') continue
    const glob = ripgrepBraces(line)
    // A pattern ripgrep's globset refuses is skipped, as ripgrep skips it.
    if (glob === undefined) continue
    rules.push({ glob, negate, dirOnly, basename: !anchored })
  }
  return rules
}

/**
 * Matchers a rule compiles to: minimatch expands `{a,b}` alternates (as
 * ripgrep's globset reads them) into one matcher each, so `{a,b}{c,d}` is
 * four. Estimated from the pattern without expanding it, counting a nested
 * group as if it multiplied its parent's (an overestimate), and stopping
 * once the count passes `limit`.
 */
export function ruleMatcherCount(rule: Pick<IgnoreRule, 'glob'>, limit = Number.MAX_SAFE_INTEGER): number {
  let total = 1
  const open: number[] = []
  const glob = rule.glob
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === '\\') index++
    else if (char === '{') open.push(1)
    else if (char === ',' && open.length > 0) open[open.length - 1]! += 1
    else if (char === '}' && open.length > 0) {
      total *= open.pop()!
      if (total > limit) return total
    }
  }
  return total
}

/**
 * Restrict `{…}` to ripgrep's dialect before minimatch, which also expands
 * numeric ranges (`{1..3}`) and empty alternatives (`ab{,c}`). ripgrep reads
 * a group with no comma as its one alternative, so its braces are dropped
 * (`{1..3}` matches the literal `1..3`), and an empty alternative matches
 * nothing, so it is removed (`ab{,c}` matches only `abc`). A group with no
 * nonempty arm matches nothing, so its pattern returns undefined.
 */
export function ripgrepBraces(glob: string): string | undefined {
  let out = ''
  const groups: Array<{ open: number; arms: number; length: number }> = []
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === '\\' && index + 1 < glob.length) {
      out += char + glob[++index]!
      if (groups.length > 0) groups.at(-1)!.length += 1
      continue
    }
    if (char === '{') {
      if (groups.length > 0) groups.at(-1)!.length += 1
      groups.push({ open: out.length, arms: 0, length: 0 })
      out += char
    } else if (char === ',' && groups.length > 0) {
      const group = groups.at(-1)!
      // An empty alternative matches nothing; the other arms stay.
      if (group.length > 0) {
        group.arms += 1
        out += char
      }
      group.length = 0
    } else if (char === '}' && groups.length > 0) {
      const group = groups.pop()!
      if (group.length > 0) group.arms += 1
      else if (out.endsWith(',')) out = out.slice(0, -1)
      if (group.arms === 0) return undefined
      if (group.arms === 1) out = out.slice(0, group.open) + out.slice(group.open + 1)
      else out += char
    } else {
      if (groups.length > 0) groups.at(-1)!.length += 1
      out += char
    }
  }
  return out
}

/** gitignore drops trailing spaces unless the last one is escaped with `\`. */
function trimTrailingSpaces(line: string): string {
  let end = line.length
  while (end > 0 && line[end - 1] === ' ') {
    if (end >= 2 && line[end - 2] === '\\') {
      // `\ ` keeps one space: drop the escape, keep the space.
      return `${line.slice(0, end - 2)} `
    }
    end--
  }
  return line.slice(0, end)
}

/** The ignore files and `.git` entry of one directory on the walk. */
export interface IgnoreFrame {
  readonly dir: string
  readonly files: Partial<Record<IgnoreKind, IgnoreRules>>
  readonly hasGit: boolean
}

/** The frames from `/` down to the directory being walked. */
export class IgnoreStack {
  private constructor(private readonly frames: readonly IgnoreFrame[]) {}

  static empty(): IgnoreStack {
    return new IgnoreStack([])
  }

  push(frame: IgnoreFrame): IgnoreStack {
    return new IgnoreStack([...this.frames, frame])
  }

  /** ripgrep's verdict for `path` (absolute), or undefined when no rule matches. */
  decide(path: string, isDir: boolean): IgnoreMatch | undefined {
    const anyGit = this.frames.some(frame => frame.hasGit)
    for (const kind of KINDS) {
      let sawGit = false
      for (let index = this.frames.length - 1; index >= 0; index--) {
        const frame = this.frames[index]!
        if (kind === 'gitignore' && (!anyGit || sawGit)) break
        const rules = frame.files[kind]
        const relative = rules === undefined ? undefined : relativeUnder(path, frame.dir)
        const match = relative === undefined ? undefined : rules!.match(relative, isDir)
        if (match !== undefined) return match
        sawGit ||= frame.hasGit
      }
    }
    return undefined
  }
}

function relativeUnder(path: string, dir: string): string | undefined {
  const prefix = dir === '/' ? '/' : `${dir}/`
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : undefined
}
