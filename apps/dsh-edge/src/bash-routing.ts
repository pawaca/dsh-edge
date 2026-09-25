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
 * Worker shell; the isolated integration suite runs every entry.
 */
export const LIGHT_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  // Shell builtins and keywords that do not run another program.
  ':', '[', '[[', 'alias', 'break', 'cd', 'continue', 'declare', 'echo', 'exit', 'export',
  'false', 'local', 'printf', 'pwd', 'read', 'readonly', 'return', 'set', 'shift', 'test',
  'true', 'type', 'unalias', 'unset',
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
  if (depth > 4) return false
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
  const tokens = tokenize(command, depth)
  if (tokens === undefined) return undefined
  const words: string[] = []
  // `name() { body; }`: the body's commands are checked where they appear, so
  // a later call to `name` starts nothing new.
  const functions = new Set<string>()
  let position: 'command' | 'args' | 'for' = 'command'
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.op !== undefined) {
      if (token.op === '()') {
        const name = words.pop()
        if (name === undefined) return undefined
        functions.add(name)
        position = 'command'
        continue
      }
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
    if (token.dynamic === true) return undefined
    if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/u.test(word)) continue // assignment prefix
    if (PREFIX_KEYWORDS.has(word)) continue
    if (CLOSING_KEYWORDS.has(word)) continue
    if (word === 'for') {
      position = 'for'
      continue
    }
    if (OPAQUE_WORDS.has(word)) return undefined
    const rest = argumentsOf(tokens, index)
    if (word === 'bash' || word === 'sh') {
      const script = inlineScript(rest)
      if (script === undefined || !runsInLightShell(script, depth + 1)) return undefined
      words.push(...(commandWords(script, depth + 1) ?? []))
      position = 'args'
      continue
    }
    if (word === 'find') {
      const executed = findExecCommand(rest)
      if (executed === null) return undefined
      if (executed !== undefined) words.push(executed)
      words.push('find')
      position = 'args'
      continue
    }
    if (WRAPPERS.has(word)) {
      const inner = wrappedCommand(word, rest)
      if (inner === null) return undefined
      words.push(word === 'xargs' && inner === undefined ? 'echo' : inner ?? word)
      if (inner !== undefined) words.push(word)
      position = 'args'
      continue
    }
    words.push(word)
    position = 'args'
  }
  return words.filter(word => !functions.has(word))
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

/** The command `find -exec`/`-execdir`/`-ok` runs: undefined without one, null when opaque. */
function findExecCommand(args: Token[]): string | undefined | null {
  const exec = args.findIndex(arg => arg.word === '-exec' || arg.word === '-execdir'
    || arg.word === '-ok' || arg.word === '-okdir')
  if (exec === -1) return undefined
  const target = args[exec + 1]
  if (target === undefined || target.dynamic === true) return null
  return target.word!
}

/**
 * The first program an `env -S`/`--split-string` string starts, null when it
 * starts one the light shell lacks or cannot be read; undefined without -S.
 */
function splitStringCommand(args: Token[]): string | null | undefined {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!.word
    if (word === undefined) continue
    let script: string | undefined
    let dynamic = false
    if (word === '-S' || word === '--split-string') {
      script = args[index + 1]?.word
      dynamic = args[index + 1]?.dynamic === true
    } else if (word.startsWith('--split-string=')) {
      script = word.slice('--split-string='.length)
      dynamic = args[index]!.dynamic === true
    } else if (/^-[^-]*S/u.test(word)) {
      script = word.slice(word.indexOf('S') + 1) || args[index + 1]?.word
      dynamic = args[index]!.dynamic === true || args[index + 1]?.dynamic === true
    } else {
      continue
    }
    if (script === undefined || dynamic || !runsInLightShell(script, 1)) return null
    return commandWords(script, 1)?.[0] ?? null
  }
  return undefined
}

/** The program a wrapper runs: undefined when it runs none, null when opaque. */
function wrappedCommand(wrapper: string, args: Token[]): string | undefined | null {
  const optionsWithValue: Record<string, ReadonlySet<string>> = {
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
  const valued = optionsWithValue[wrapper] ?? new Set<string>()
  // `env -S 'cmd args'` splits and runs the string: judge it as a command line.
  if (wrapper === 'env') {
    const split = splitStringCommand(args)
    if (split !== undefined) return split
  }
  let index = 0
  // `command -v`/`-V` looks a name up instead of running it.
  if (wrapper === 'command' && args.some(arg => arg.word === '-v' || arg.word === '-V')) return undefined
  while (index < args.length) {
    const arg = args[index]!
    if (arg.dynamic === true) return null
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
    if (wrapper === 'timeout') {
      index++ // the duration
      break
    }
    break
  }
  const inner = args[index]
  if (inner === undefined) return undefined
  if (inner.dynamic === true) return null
  return inner.word
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
      if (end === -1 || !runsInLightShell(source.slice(index + 1, end), depth + 1)) return undefined
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
      if (text[index + 2] !== '(' && !runsInLightShell(text.slice(index + 2, end), depth + 1)) return false
      index = end + 1
      continue
    }
    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1)
      if (end === -1 || !runsInLightShell(text.slice(index + 1, end), depth + 1)) return false
      index = end + 1
      continue
    }
    index++
  }
  return true
}
