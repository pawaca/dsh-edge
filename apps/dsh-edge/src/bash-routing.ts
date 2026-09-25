/**
 * Route one bash command to the lightweight shell (just-bash) or the Linux
 * container.
 *
 * just-bash runs file and text commands in milliseconds at no extra cost, but
 * has no git, node, npm, python, or network. A deployment with a container
 * sends a command there only when it needs Linux. The classifier is
 * deliberately conservative: a command it cannot see through goes to the
 * container, because a slower command is better than one that fails.
 */

/** How a deployment with a container routes bash commands. */
export type BashRoutingPolicy = 'auto' | 'light' | 'container'

export type BashRoute = 'light' | 'container'

/**
 * Commands the lightweight shell runs correctly. Registered-but-unusable
 * just-bash commands (git without a client, jq/yq/sqlite3/xan/file/
 * html-to-markdown without their bundled chunks, curl without egress) are
 * absent on purpose, as are `split` and `which`, which fail in the Dynamic
 * Worker shell, and `type`, whose program lookups are only truthful in the
 * container; the isolated integration suite runs every entry.
 */
export const LIGHT_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  // Shell builtins and keywords that do not run another program.
  ':', '[', '[[', 'alias', 'break', 'cd', 'continue', 'declare', 'echo', 'exit', 'export',
  'false', 'printf', 'pwd', 'read', 'readonly', 'set', 'shift', 'test',
  'true', 'unalias', 'unset',
  // just-bash commands.
  'awk', 'base64', 'basename', 'cat', 'chmod', 'clear', 'column', 'comm', 'cp', 'cut', 'date',
  'diff', 'dirname', 'du', 'egrep', 'expand', 'expr', 'fgrep', 'find', 'fold', 'grep', 'gunzip',
  'gzip', 'head', 'help', 'history', 'hostname', 'join', 'ln', 'ls', 'md5sum', 'mkdir', 'mv',
  'nl', 'od', 'paste', 'printenv', 'readlink', 'rev', 'rg', 'rm', 'rmdir', 'sed', 'seq',
  'sha1sum', 'sha256sum', 'sleep', 'sort', 'stat', 'strings', 'tac', 'tail', 'tar',
  'tee', 'touch', 'tr', 'tree', 'uniq', 'unexpand', 'wc', 'whoami', 'zcat',
  // just-bash wrappers and nested shells; what they run is checked separately.
  'bash', 'env', 'sh', 'time', 'timeout', 'xargs',
])

/** Wrappers whose real command follows their options. */
const WRAPPERS = new Set(['env', 'timeout', 'time', 'nice', 'nohup', 'command', 'exec', 'xargs'])
/** Words that start a compound command; the next word is in command position again. */
const PREFIX_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '('])
/** Words that only close a compound command. */
const CLOSING_KEYWORDS = new Set(['fi', 'done', '}', ')', 'esac'])
/** Constructs the tokenizer does not model; they send the whole command to the container. */
const OPAQUE_WORDS = new Set(['eval', 'source', '.', 'case', 'select', 'function', 'coproc', 'trap'])

/** Choose where one command runs. `container` is never returned when no container exists. */
export function routeBashCommand(command: string, options: {
  policy: BashRoutingPolicy
  containerAvailable: boolean
  requestContainer?: boolean
  /** The command's working directory, used to resolve relative `..` paths. */
  cwd?: string
}): BashRoute {
  if (!options.containerAvailable || options.policy === 'light') return 'light'
  if (options.policy === 'container' || options.requestContainer === true) return 'container'
  const previous = routingCwd
  routingCwd = options.cwd ?? SHARED_ROOT
  try {
    return runsInLightShell(command) ? 'light' : 'container'
  } finally {
    routingCwd = previous
  }
}

const SHARED_ROOT = '/workspace'
/** The working directory of the command being routed (synchronous, single-threaded). */
let routingCwd = SHARED_ROOT

/** Whether every program a command would start is one the lightweight shell provides. */
export function runsInLightShell(command: string, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false
  const words = commandWords(command, depth)
  return words !== undefined && words.every(word => LIGHT_SHELL_COMMANDS.has(word))
}

interface Token {
  /** The word with quotes removed; undefined for an operator. */
  word?: string
  op?: string
  /** The word contained an unquoted expansion ($x, $(…), `…`, globs are fine). */
  dynamic?: boolean
}

/**
 * The program names a command would start, in order, or undefined when the
 * command contains something the tokenizer cannot see through.
 */
export function commandWords(command: string, depth = 0): string[] | undefined {
  if (depth > MAX_DEPTH) return undefined
  const tokens = tokenize(command, depth)
  if (tokens === undefined || tokens.some(touchesContainerFilesystem) || changesDirectoryOpaquely(tokens)) {
    return undefined
  }
  return wordsOf(tokens, depth)
}

/**
 * Relative paths are resolved against the starting directory. A directory
 * change to an unknown place (`cd "$d"`, `cd -`, `cd ~`), or any directory
 * change combined with `..` traversal, is not modelled, so opaque.
 */
function changesDirectoryOpaquely(tokens: Token[]): boolean {
  const changes = tokens.flatMap((token, index) =>
    token.word === 'cd' || token.word === 'pushd' || token.word === 'popd' ? [index] : [])
  if (changes.length === 0) return false
  const unknownTarget = changes.some(index => {
    const target = tokens[index + 1]
    return tokens[index]!.word === 'popd' || target?.dynamic === true
      || target?.word === '-' || target?.word?.startsWith('~') === true
  })
  const traversal = tokens.some(token => token.word?.split('/').includes('..') === true)
  return unknownTarget || traversal
}

/**
 * The light shell shares only /workspace with the container. A word naming a
 * Linux root directory (as an argument, `--opt=/path`, or a redirection
 * target) or a home path addresses the container's own filesystem, so the
 * command needs the container. Regex-like words such as `/start/` in sed are
 * not affected because only known root directories count.
 */
function escapesSharedRoot(path: string): boolean {
  const segments = path.split('/')
  if (!segments.includes('..')) return false
  const resolved = path.startsWith('/') ? [] : routingCwd.split('/').filter(Boolean)
  for (const segment of segments) {
    if (segment === '..') resolved.pop()
    else if (segment !== '' && segment !== '.') resolved.push(segment)
  }
  return resolved[0] !== 'workspace'
}

const LINUX_ROOTS = new Set(['bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib32', 'lib64', 'media', 'mnt',
  'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var'])
const SHARED_DEVICES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/zero'])

function touchesContainerFilesystem(token: Token): boolean {
  const word = token.word
  if (word === undefined) return false
  if (word.startsWith('~')) return true
  // A path that climbs out of /workspace with `..` reaches the container's root.
  if (word.split(/[=:,]/u).some(part => escapesSharedRoot(part))) return true
  return word.split(/[=:,]/u).some(part => {
    const match = /^\/([A-Za-z0-9._-]+)/u.exec(part)
    return match !== null && LINUX_ROOTS.has(match[1]!) && !SHARED_DEVICES.has(part)
  })
}

/** Nesting limit for commands inside commands (wrappers, `bash -c`, substitutions). */
const MAX_DEPTH = 4

/**
 * Walk tokens in command position. Every construct that runs another command
 * (a wrapper's remaining arguments, each `find` action, a `bash -c` script,
 * an `env -S` string) is walked again as a command of its own, so nesting
 * of any shape is checked by this one loop.
 */
function wordsOf(tokens: Token[], depth: number): string[] | undefined {
  if (depth > MAX_DEPTH) return undefined
  const words: string[] = []
  let position: 'command' | 'args' | 'for' = 'command'
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.op !== undefined) {
      // A function definition can shadow any program depending on execution
      // order; not modelled, so opaque.
      if (token.op === '()') return undefined
      if (isRedirection(token.op)) {
        index++ // the redirection target is not a command
        continue
      }
      position = 'command'
      continue
    }
    const word = token.word!
    if (position === 'for') {
      if (word === 'do') position = 'command'
      continue
    }
    if (position === 'args') continue
    const invoked = invokedWords(tokens, index, depth)
    if (invoked === undefined) return undefined
    words.push(...invoked.words)
    if (invoked.next === 'for') position = 'for'
    else if (invoked.next === 'args') position = 'args'
  }
  return words
}

/** The programs one command-position word starts, following what it runs. */
function invokedWords(tokens: Token[], index: number, depth: number): {
  words: string[]
  next: 'command' | 'args' | 'for'
} | undefined {
  const token = tokens[index]!
  const word = token.word!
  if (token.dynamic === true) return undefined
  if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/u.test(word)) return { words: [], next: 'command' }
  if (PREFIX_KEYWORDS.has(word) || CLOSING_KEYWORDS.has(word)) return { words: [], next: 'command' }
  if (word === 'for') return { words: [], next: 'for' }
  if (OPAQUE_WORDS.has(word)) return undefined
  const rest = argumentsOf(tokens, index)
  if (word === 'bash' || word === 'sh') {
    const script = inlineScript(rest)
    const inner = script === undefined ? undefined : commandWords(script, depth + 1)
    return inner === undefined ? undefined : { words: [word, ...inner], next: 'args' }
  }
  if (word === 'find') {
    const inner = findActionWords(rest, depth)
    return inner === undefined ? undefined : { words: [word, ...inner], next: 'args' }
  }
  if (WRAPPERS.has(word)) {
    const inner = wrappedWords(word, rest, depth)
    return inner === undefined ? undefined : { words: [word, ...inner], next: 'args' }
  }
  if (startsProgramsItself(word, rest)) return undefined
  return { words: [word], next: 'args' }
}

const SELF_EXECUTING_TOOLS = new Set(['rg', 'tar', 'sort', 'awk', 'sed'])

/**
 * Light-shell tools that can start programs through their own options or
 * scripts. These forms are opaque. The list covers the common, cheaply
 * detectable ones; anything it misses fails in the light shell with a missing
 * program, and the result tells the agent to retry with `linux: true`.
 */
function startsProgramsItself(program: string, args: Token[]): boolean {
  if (!SELF_EXECUTING_TOOLS.has(program)) return false
  // An expanded argument could become any of the forms below.
  if (args.some(arg => arg.dynamic === true)) return true
  const words = args.map(arg => arg.word ?? '')
  const option = (...names: string[]) => words.some(word =>
    names.some(name => word === name || word.startsWith(`${name}=`)))
  switch (program) {
    case 'rg':
      return option('--pre')
    case 'tar':
      return option('--use-compress-program', '--to-command', '--checkpoint-action',
        '--info-script', '--new-volume-script', '--rsh-command', '--rmt-command')
        // -I PROG / -F SCRIPT, separate or attached (`-Izstd`).
        || words.some(word => /^-(I|F)/u.test(word))
    case 'sort':
      return option('--compress-program')
    case 'awk':
      // A program read from a file cannot be inspected; system(),
      // `cmd | getline`, and `print | "cmd"` run programs.
      return option('-f', '--file') || words.some(word => /^-[^-]*f/u.test(word))
        || words.some(word => /\bsystem\s*\(|\|/u.test(word))
    case 'sed':
      // A script read from a file cannot be inspected.
      if (option('-f', '--file') || words.some(word => /^-[^-]*f/u.test(word))) return true
      // The `e` command and the `s///e` flag run programs.
      // An `e` command can follow any address form (line, `$`, /re/, \cREc,
      // ranges, `!`), so any standalone `e` counts; so does the `s///e` flag.
      return words.some(word => /(^|[^A-Za-z_])e(\s|$|;|\})|s(.)(?:(?!\3).)*\3(?:(?!\3).)*\3[a-zA-Z0-9]*e/u.test(word))
    default:
      return false
  }
}

function argumentsOf(tokens: Token[], start: number): Token[] {
  const rest: Token[] = []
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.op !== undefined && !isRedirection(token.op)) break
    if (token.op !== undefined) {
      index++
      continue
    }
    rest.push(token)
  }
  return rest
}

/**
 * `bash -c '…'` with a literal script; undefined for anything else. Options
 * are read only before the first operand (a script file, whose contents are
 * unknown), and only known ones count: an unknown option or `-o`/`-O` value
 * makes the command opaque.
 */
function inlineScript(args: Token[]): string | undefined {
  const longFlags = new Set(['--norc', '--noprofile', '--posix', '--login', '--noediting', '--restricted'])
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg.dynamic === true) return undefined
    const word = arg.word!
    if (word.startsWith('--')) {
      if (!longFlags.has(word)) return undefined
      continue
    }
    if (!word.startsWith('-') || word === '-') return undefined // a script operand or stdin
    const letters = word.slice(1)
    if (!/^[abefhkmnprtuvxBCEHPTil]*c?[abefhkmnprtuvxBCEHPTil]*$/u.test(letters)) return undefined
    if (letters.includes('c')) {
      const script = args[index + 1]
      if (script === undefined || script.dynamic === true) return undefined
      return script.word
    }
  }
  return undefined
}

const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** Every program `find` actions run; each action's command is walked in full. */
function findActionWords(args: Token[], depth: number): string[] | undefined {
  const words: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (!FIND_ACTIONS.has(args[index]!.word ?? '')) continue
    const end = args.findIndex((arg, at) => at > index && (arg.word === ';' || arg.word === '+'))
    if (end === -1) return undefined
    const inner = wordsOf(args.slice(index + 1, end), depth + 1)
    if (inner === undefined || inner.length === 0) return undefined
    words.push(...inner)
    index = end
  }
  return words
}

/**
 * Each wrapper's known options: `flags` take no value, `valued` take the next
 * argument (short ones may also attach it, like `-n1`). An option outside
 * both sets might consume the next argument, so it makes the command opaque.
 */
const WRAPPER_OPTIONS: Readonly<Record<string, { flags: ReadonlySet<string>; valued: ReadonlySet<string> }>> = {
  env: {
    flags: new Set(['-i', '--ignore-environment', '-0', '--null', '-v', '--debug']),
    valued: new Set(['-u', '--unset', '-C', '--chdir']),
  },
  timeout: {
    flags: new Set(['--preserve-status', '--foreground', '-v', '--verbose']),
    valued: new Set(['-s', '--signal', '-k', '--kill-after']),
  },
  nice: { flags: new Set(), valued: new Set(['-n', '--adjustment']) },
  xargs: {
    flags: new Set(['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive',
      '-x', '--exit', '-o', '--open-tty']),
    valued: new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '--max-lines', '-n',
      '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var']),
  },
  command: { flags: new Set(['-p']), valued: new Set() },
  exec: { flags: new Set(['-c', '-l']), valued: new Set(['-a']) },
  time: {
    flags: new Set(['-p', '--portability', '-v', '--verbose', '-q', '--quiet', '-a', '--append']),
    valued: new Set(['-f', '--format', '-o', '--output']),
  },
  nohup: { flags: new Set(), valued: new Set() },
}

/** How many arguments one wrapper option spans: 1 or 2, or undefined when unknown. */
function optionSpan(wrapper: string, word: string): 1 | 2 | undefined {
  const known = WRAPPER_OPTIONS[wrapper]
  if (known === undefined) return undefined
  if (word.startsWith('--') && word.includes('=')) {
    const name = word.slice(0, word.indexOf('='))
    return known.valued.has(name) || known.flags.has(name) ? 1 : undefined
  }
  if (known.flags.has(word)) return 1
  if (known.valued.has(word)) return 2
  // An attached short value (`-n1`, `-I{}`) or `nice -5`.
  if (!word.startsWith('--') && known.valued.has(word.slice(0, 2))) return 1
  if (wrapper === 'nice' && /^-[0-9]+$/u.test(word)) return 1
  return undefined
}

/**
 * The programs a wrapper runs, walking its remaining arguments as a command
 * (so wrappers nest). `xargs` with no command runs `echo`; `command -v` only
 * looks a name up. Undefined when the wrapped command cannot be read.
 */
function wrappedWords(wrapper: string, args: Token[], depth: number): string[] | undefined {
  if (wrapper === 'command' && args.some(arg => arg.word === '-v' || arg.word === '-V')) return []
  // `env -S` splits a string into the command and then appends the
  // remaining arguments; not modelled, so opaque.
  if (wrapper === 'env' && splitString(args) !== undefined) return undefined
  let index = 0
  while (index < args.length) {
    const arg = args[index]!
    if (arg.dynamic === true) return undefined
    const word = arg.word!
    if (word === '--') {
      index++
      break
    }
    if (word.startsWith('-') && word !== '-') {
      const span = optionSpan(wrapper, word)
      if (span === undefined) return undefined
      index += span
      continue
    }
    if (wrapper === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) {
      index++
      continue
    }
    if (wrapper === 'timeout') index++ // the duration
    break
  }
  const tail = args.slice(index)
  if (tail.length === 0) return wrapper === 'xargs' ? ['echo'] : []
  return wordsOf(wrapper === 'xargs' ? withStdinArguments(args.slice(0, index), tail) : tail, depth + 1)
}

/**
 * xargs puts stdin items into its command: in place of the replacement
 * string (`-I R`, `-i`, `--replace`) or after the initial arguments. Those
 * positions are dynamic, so a self-executing tool there is opaque.
 */
function withStdinArguments(options: Token[], tail: Token[]): Token[] {
  const words = options.map(option => option.word ?? '')
  const replace = new Set<string>()
  words.forEach((word, index) => {
    if (word === '-I' && words[index + 1] !== undefined) replace.add(words[index + 1]!)
    else if (word.startsWith('-I') && word.length > 2) replace.add(word.slice(2))
    else if (word === '-i' || word === '--replace') replace.add('{}')
    else if (word.startsWith('-i') && word.length > 2) replace.add(word.slice(2))
    else if (word.startsWith('--replace=')) replace.add(word.slice('--replace='.length))
  })
  const marked = tail.map((token, index) => index > 0 && token.word !== undefined
    && [...replace].some(value => value !== '' && token.word!.includes(value))
    ? { ...token, dynamic: true }
    : token)
  return [...marked, { word: '', dynamic: true }]
}

/** The string `env -S`/`--split-string` runs; null when dynamic or missing, undefined without -S. */
function splitString(args: Token[]): string | null | undefined {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!.word
    if (word === undefined) continue
    let script: Token | undefined
    let inline: string | undefined
    if (word === '-S' || word === '--split-string') {
      script = args[index + 1]
    } else if (word.startsWith('--split-string=')) {
      inline = word.slice('--split-string='.length)
    } else if (/^-[^-]*S/u.test(word)) {
      inline = word.slice(word.indexOf('S') + 1)
      if (inline === '') script = args[index + 1]
    } else {
      continue
    }
    if (inline !== undefined && inline !== '') return args[index]!.dynamic === true ? null : inline
    if (script === undefined || script.dynamic === true) return null
    return script.word!
  }
  return undefined
}

function isRedirection(op: string): boolean {
  return /^[0-9]*(<|>|>>|<>|>&|<&|>\||&>|&>>|<<|<<-|<<<)$/u.test(op)
}

/**
 * Split a command into words and operators with bash quoting rules. Returns
 * undefined for unbalanced quotes or substitutions, and recurses into `$(…)`
 * and backquoted substitutions so the programs they start are checked too.
 */
function tokenize(source: string, depth: number): Token[] | undefined {
  // `${x@P}` prompt-expands a value, running command substitutions inside it.
  if (/\$\{[^}]*@P\}/u.test(source)) return undefined
  // BASH_ENV / ENV name a startup file a nested shell sources first.
  if (/(^|[\s;&|(`])(export\s+)?(BASH_ENV|ENV)=/u.test(source)) return undefined
  const tokens: Token[] = []
  let word = ''
  let inWord = false
  let dynamic = false
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean; expands: boolean }> = []
  const flush = () => {
    if (inWord) tokens.push({ word, ...dynamic ? { dynamic: true } : {} })
    word = ''
    inWord = false
    dynamic = false
  }
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === '\\') {
      if (source[index + 1] === '\n') {
        index += 2
        continue
      }
      // An escaped substitution is code kept for later evaluation.
      if (source[index + 1] === '`' || (source[index + 1] === '$' && source[index + 2] === '(')) return undefined
      word += source[index + 1] ?? ''
      inWord = true
      index += 2
      continue
    }
    if (char === "'") {
      const end = source.indexOf("'", index + 1)
      if (end === -1) return undefined
      // A quoted substitution is code kept for later evaluation (prompt
      // expansion, arithmetic, a nested shell); not modelled, so opaque.
      if (/\$\(|`/u.test(source.slice(index + 1, end))) return undefined
      word += source.slice(index + 1, end)
      inWord = true
      index = end + 1
      continue
    }
    if (char === '"') {
      const end = closingDoubleQuote(source, index + 1)
      if (end === undefined) return undefined
      const inner = source.slice(index + 1, end)
      if (!substitutionsAreLight(inner, depth)) return undefined
      // Any expansion, including a checked substitution, makes the value unknown.
      if (/\$[A-Za-z_{0-9@*#?$!([-]|`/u.test(inner)) dynamic = true
      word += inner
      inWord = true
      index = end + 1
      continue
    }
    if (char === '$' && source[index + 1] === '(') {
      const end = closingParen(source, index + 2)
      if (end === undefined) return undefined
      if (source[index + 2] === '(') {
        // Arithmetic runs no program itself, but substitutions inside it do.
        if (!substitutionsAreLight(source.slice(index + 3, end), depth)) return undefined
        word += '0'
      } else if (!runsInLightShell(source.slice(index + 2, end), depth + 1)) {
        return undefined
      }
      dynamic = true
      inWord = true
      index = end + 1
      continue
    }
    if (char === '`') {
      const end = source.indexOf('`', index + 1)
      // Escaped backquotes nest substitutions; not modelled, so opaque.
      if (end === -1 || source[end - 1] === '\\'
        || !runsInLightShell(source.slice(index + 1, end), depth + 1)) return undefined
      dynamic = true
      inWord = true
      index = end + 1
      continue
    }
    if (char === '$') {
      dynamic = true
      word += char
      inWord = true
      index++
      continue
    }
    if (char === '#' && !inWord) {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end
      continue
    }
    if (char === '\n') {
      flush()
      tokens.push({ op: ';' })
      index++
      // Heredoc bodies begin on the next line and are data, not commands.
      for (const heredoc of pendingHeredocs.splice(0)) {
        const skipped = skipHeredoc(source, index, heredoc)
        if (skipped === undefined) return undefined
        if (heredoc.expands && !substitutionsAreLight(skipped.body, depth)) return undefined
        index = skipped.next
      }
      continue
    }
    if (char === ' ' || char === '\t') {
      flush()
      index++
      continue
    }
    if ((char === '<' || char === '>') && source[index + 1] === '(') {
      // Process substitution `<(…)`/`>(…)` starts the commands inside it.
      const end = closingParen(source, index + 2)
      if (end === undefined || !runsInLightShell(source.slice(index + 2, end), depth + 1)) return undefined
      dynamic = true
      inWord = true
      index = end + 1
      continue
    }
    if (char === '(' && inWord && word.endsWith('=')) {
      // Array assignment `name=(a b)`: the list is data, not a subshell.
      const end = closingParen(source, index + 1)
      if (end === undefined || !substitutionsAreLight(source.slice(index + 1, end), depth)) return undefined
      word += source.slice(index, end + 1)
      index = end + 1
      continue
    }
    const operator = readOperator(source, index)
    if (operator !== undefined) {
      if (/^[0-9]+$/u.test(word) && inWord && /^[<>]/u.test(operator)) {
        word = ''
        inWord = false
        tokens.push({ op: `${word}${operator}` })
      } else {
        flush()
        if (operator === '(' && source[index + 1] === ')') {
          tokens.push({ op: '()' })
          index += 2
          continue
        }
        tokens.push({ op: operator })
      }
      index += operator.length
      if (operator === '<<' || operator === '<<-') {
        const heredoc = readHeredocDelimiter(source, index)
        if (heredoc === undefined) return undefined
        pendingHeredocs.push({ ...heredoc, stripTabs: operator === '<<-' })
        index = heredoc.next
        tokens.push({ word: heredoc.delimiter })
      }
      continue
    }
    word += char
    inWord = true
    index++
  }
  flush()
  if (pendingHeredocs.length > 0) return undefined
  return tokens
}

const OPERATORS = ['&&', '||', ';;', '|&', '<<-', '<<<', '<<', '>>', '&>>', '&>', '>&', '<&', '<>', '>|',
  ';', '&', '|', '(', ')', '<', '>']

function readOperator(source: string, index: number): string | undefined {
  return OPERATORS.find(operator => source.startsWith(operator, index))
}

function readHeredocDelimiter(source: string, start: number): {
  delimiter: string
  expands: boolean
  next: number
} | undefined {
  let index = start
  while (source[index] === ' ' || source[index] === '\t') index++
  const quote = source[index]
  if (quote === "'" || quote === '"') {
    const end = source.indexOf(quote, index + 1)
    if (end === -1) return undefined
    return { delimiter: source.slice(index + 1, end), expands: false, next: end + 1 }
  }
  const match = /^[^\s;&|<>()]+/u.exec(source.slice(index))
  if (match === null) return undefined
  const raw = match[0]
  return { delimiter: raw.replaceAll('\\', ''), expands: !raw.includes('\\'), next: index + raw.length }
}

function skipHeredoc(source: string, start: number, heredoc: { delimiter: string; stripTabs: boolean }):
{ body: string; next: number } | undefined {
  let index = start
  while (index <= source.length) {
    const end = source.indexOf('\n', index)
    const line = source.slice(index, end === -1 ? source.length : end)
    const candidate = heredoc.stripTabs ? line.replace(/^\t+/u, '') : line
    if (candidate === heredoc.delimiter) {
      return { body: source.slice(start, index), next: end === -1 ? source.length : end + 1 }
    }
    if (end === -1) return undefined
    index = end + 1
  }
  return undefined
}

function closingDoubleQuote(source: string, start: number): number | undefined {
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '"') return index
    if (char === '$' && source[index + 1] === '(') {
      const end = closingParen(source, index + 2)
      if (end === undefined) return undefined
      index = end + 1
      continue
    }
    index++
  }
  return undefined
}

function closingParen(source: string, start: number): number | undefined {
  let depth = 1
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === "'") {
      const end = source.indexOf("'", index + 1)
      if (end === -1) return undefined
      index = end + 1
      continue
    }
    if (char === '"') {
      const end = closingDoubleQuote(source, index + 1)
      if (end === undefined) return undefined
      index = end + 1
      continue
    }
    if (char === '(') depth++
    if (char === ')') {
      depth--
      if (depth === 0) return index
    }
    index++
  }
  return undefined
}

/** Check the `$(…)` and backquoted substitutions inside double quotes or a heredoc body. */
function substitutionsAreLight(text: string, depth: number): boolean {
  let index = 0
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2
      continue
    }
    if (text[index] === '$' && text[index + 1] === '(') {
      const end = closingParen(text, index + 2)
      if (end === undefined) return false
      const light = text[index + 2] === '('
        ? substitutionsAreLight(text.slice(index + 3, end), depth + 1)
        : runsInLightShell(text.slice(index + 2, end), depth + 1)
      if (!light) return false
      index = end + 1
      continue
    }
    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1)
      if (end === -1 || text[end - 1] === '\\'
        || !runsInLightShell(text.slice(index + 1, end), depth + 1)) return false
      index = end + 1
      continue
    }
    index++
  }
  return true
}
