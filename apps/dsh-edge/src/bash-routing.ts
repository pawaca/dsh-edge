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
  // just-bash wrappers; the program they run is checked separately.
  'env', 'time', 'timeout', 'xargs',
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
}): BashRoute {
  if (!options.containerAvailable || options.policy === 'light') return 'light'
  if (options.policy === 'container' || options.requestContainer === true) return 'container'
  return runsInLightShell(command) ? 'light' : 'container'
}

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
  return tokens === undefined ? undefined : wordsOf(tokens, depth)
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
    // The inline script runs in the same shell; only its programs matter.
    return inner === undefined ? undefined : { words: inner, next: 'args' }
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

/**
 * Light-shell tools that can start programs through their own options or
 * scripts. These forms are opaque. The list covers the common, cheaply
 * detectable ones; anything it misses fails in the light shell with a missing
 * program, and the result tells the agent to retry with `linux: true`.
 */
function startsProgramsItself(program: string, args: Token[]): boolean {
  const words = args.map(arg => arg.word ?? '')
  const option = (...names: string[]) => words.some(word =>
    names.some(name => word === name || word.startsWith(`${name}=`)))
  switch (program) {
    case 'rg':
      return option('--pre')
    case 'tar':
      return option('-I', '--use-compress-program', '--to-command', '--checkpoint-action',
        '--info-script', '--new-volume-script', '-F')
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
      // An `e` command may follow an address: a line number, `$`, a /regex/,
      // a range, or `!`.
      return words.some(word => /(^|[;\n{}0-9$/!,])\s*e(\s|$|;)|s(.)(?:(?!\3).)*\3(?:(?!\3).)*\3[a-zA-Z0-9]*e/u.test(word))
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

/** `bash -c '…'` with a literal script; undefined for anything else (a script file, stdin, dynamic). */
function inlineScript(args: Token[]): string | undefined {
  const flag = args.findIndex(arg => arg.word !== undefined && /^-[a-z]*c[a-z]*$/u.test(arg.word))
  const script = flag === -1 ? undefined : args[flag + 1]
  if (script === undefined || script.dynamic === true) return undefined
  return script.word
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

const WRAPPER_VALUED_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  xargs: new Set(['-a', '-d', '-E', '-e', '-I', '-i', '-L', '-l', '-n', '-P', '-s', '--arg-file',
    '--delimiter', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--replace']),
  command: new Set(),
  exec: new Set(['-a']),
  time: new Set(['-f', '-o', '--format', '--output']),
  nohup: new Set(),
}

/**
 * The programs a wrapper runs, walking its remaining arguments as a command
 * (so wrappers nest). `xargs` with no command runs `echo`; `command -v` only
 * looks a name up. Undefined when the wrapped command cannot be read.
 */
function wrappedWords(wrapper: string, args: Token[], depth: number): string[] | undefined {
  if (wrapper === 'command' && args.some(arg => arg.word === '-v' || arg.word === '-V')) return []
  if (wrapper === 'env') {
    const split = splitString(args)
    if (split === null) return undefined
    if (split !== undefined) return commandWords(split, depth + 1)
  }
  const valued = WRAPPER_VALUED_OPTIONS[wrapper] ?? new Set<string>()
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
      index += valued.has(word) ? 2 : 1
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
  return wordsOf(tail, depth + 1)
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
      word += source[index + 1] ?? ''
      inWord = true
      index += 2
      continue
    }
    if (char === "'") {
      const end = source.indexOf("'", index + 1)
      if (end === -1) return undefined
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
      if (/\$[A-Za-z_{0-9@*#?$!-]/u.test(inner.replace(/\$\(/gu, ''))) dynamic = true
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
