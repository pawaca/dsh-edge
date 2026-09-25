import { describe, expect, it } from 'vitest'
import { LIGHT_SHELL_COMMANDS, commandWords, routeBashCommand, runsInLightShell } from '../src/bash-routing.ts'
import { LIGHT_SHELL_SAMPLES, LIGHT_SHELL_SETUP } from './fixtures/light-shell-samples.mjs'

const auto = (command: string, requestContainer?: boolean) => routeBashCommand(command, {
  policy: 'auto',
  containerAvailable: true,
  ...requestContainer === undefined ? {} : { requestContainer },
})

describe('bash command routing', () => {
  it.each([
    ['ls -la src && grep -rn TODO src | head', 'light'],
    ["find . -name '*.ts' | xargs wc -l", 'light'],
    ['cat package.json | jq .version', 'container'],
    ['npm test', 'container'],
    ['git status', 'container'],
    ["python3 -c 'print(1)'", 'container'],
    ['bash -c "$CMD"', 'container'],
    ["eval 'make all'", 'container'],
    ['x=node; $x -v', 'container'],
    ['timeout 5 npm test', 'container'],
    ['env X=1 go build', 'container'],
    ['sudo apt-get install x', 'container'],
    ['ls | xargs rm', 'light'],
    ['find . -exec pip install {} \\;', 'container'],
    ['find . -name "*.log" -exec rm {} \\;', 'light'],
    // The light shell has no node, so the lookup is only truthful in the container.
    ['command -v node', 'container'],
    ['command -v ls', 'container'],
    ['f(){ gcc a.c; }; f', 'container'],
  ] as const)('routes %s to %s', (command, route) => {
    expect(auto(command)).toBe(route)
  })

  it('keeps everyday file and text work in the light shell', () => {
    for (const command of [
      'pwd',
      'mkdir -p out && cp a.txt out/ && mv out/a.txt out/b.txt',
      "sed -n '1,20p' src/index.ts",
      "awk -F, '{ sum += $2 } END { print sum }' data.csv",
      'rg -n "export function" src | sort | uniq -c',
      'tree -L 2',
      'wc -l $(find src -name "*.ts")',
      'echo "done at $(date)"',
      'cd app && ls',
      'FOO=bar printenv FOO',
      'tail -n 50 log.txt > last.txt 2>&1',
      'if [ -f a ]; then cat a; else echo missing; fi',
      'for f in *.md; do head -1 "$f"; done',
      "bash -c 'ls | wc -l'",
      'echo $((1 + 2))',
      'files=(a.txt b.txt); echo "${files[0]}"',
      '# just a comment',
    ]) {
      expect(auto(command), command).toBe('light')
    }
  })

  it('writes files through heredocs without treating the body as commands', () => {
    expect(auto("cat > notes.md <<'EOF'\nnpm install\ngit push\nEOF\nwc -l notes.md")).toBe('light')
    expect(auto('cat <<EOF > a.txt\nvalue: $(date)\nEOF')).toBe('light')
    // An unquoted heredoc expands substitutions, which are checked.
    expect(auto('cat <<EOF > a.txt\n$(node -v)\nEOF')).toBe('container')
    // Unterminated heredoc: cannot see through it.
    expect(auto('cat <<EOF\nno end')).toBe('container')
  })

  it('checks programs started inside substitutions', () => {
    expect(auto('echo "version $(node -v)"')).toBe('container')
    expect(auto('echo `git rev-parse HEAD`')).toBe('container')
    expect(auto('echo "$(ls | wc -l) files"')).toBe('light')
  })

  it('sends anything it cannot parse to the container', () => {
    expect(auto('echo "unterminated')).toBe('container')
    expect(auto("echo 'unterminated")).toBe('container')
    expect(auto('echo $(ls')).toBe('container')
    expect(auto('./scripts/build.sh')).toBe('container')
    expect(auto('/usr/bin/env node app.js')).toBe('container')
    expect(auto('source .env && ls')).toBe('container')
    expect(auto('case $x in a) ls;; esac')).toBe('container')
  })

  // Every construct that can start a program is either checked recursively or
  // treated as opaque; none may hide a program from the classifier.
  it.each([
    ['cat <(node -v)', 'container'],
    ['diff <(ls a) <(ls b)', 'light'],
    ['tee >(gzip > out.gz) < a.txt', 'light'],
    ['tee >(python3 -c "import sys") < a.txt', 'container'],
    ['echo $(( $(node -p 1) + 1 ))', 'container'],
    ['echo $(( `git rev-list --count HEAD` * 2 ))', 'container'],
    ['echo $(( 1 + $(wc -l < a.txt) ))', 'light'],
    ['(( $(node -p 1) > 0 )) && echo yes', 'container'],
    ['echo $[ $(node -p 1) + 1 ]', 'container'],
    ["env -S 'node -v'", 'container'],
    ["env --split-string='python3 x.py'", 'container'],
    ["env -S 'ls -la'", 'light'],
    ['env -S "$CMD"', 'container'],
    ['echo "${NAME:-$(git config user.name)}"', 'container'],
    ['cat <<< "$(node -v)"', 'container'],
    ['cat <<< "$(date)"', 'light'],
    ["$'no\x64e' -v", 'container'],
  ] as const)('checks programs hidden in %s', (command, route) => {
    expect(auto(command)).toBe(route)
  })

  it('honours the policy, the explicit request, and a missing container', () => {
    expect(routeBashCommand('npm test', { policy: 'auto', containerAvailable: false })).toBe('light')
    expect(routeBashCommand('npm test', { policy: 'light', containerAvailable: true })).toBe('light')
    expect(routeBashCommand('ls', { policy: 'container', containerAvailable: true })).toBe('container')
    expect(auto('ls', true)).toBe('container')
    expect(routeBashCommand('ls', { policy: 'light', containerAvailable: true, requestContainer: true }))
      .toBe('light')
  })

  it('lists the programs a command starts, including wrapped ones', () => {
    expect(commandWords('cd app && npm install lodash | tee log; python3 -c "print(1)"'))
      .toEqual(['cd', 'npm', 'tee', 'python3'])
    expect(commandWords('timeout -s KILL 5 npm test')).toEqual(['npm', 'timeout'])
    expect(commandWords('env -u HOME A=1 node x.js')).toEqual(['node', 'env'])
    expect(commandWords('ls | xargs -n 1 -I{} cp {} out/')).toEqual(['ls', 'cp', 'xargs'])
    expect(commandWords('ls > out.txt 2>&1 < in.txt')).toEqual(['ls'])
    expect(commandWords('eval ls')).toBeUndefined()
  })

  it('bounds recursion through nested shells', () => {
    let nested = 'ls'
    for (let level = 0; level < 8; level++) nested = `bash -c ${JSON.stringify(nested)}`
    expect(runsInLightShell(nested)).toBe(false)
  })

  it('has one integration sample per light-shell command, each routed to the light shell', () => {
    expect(Object.keys(LIGHT_SHELL_SAMPLES).sort()).toEqual([...LIGHT_SHELL_COMMANDS].sort())
    expect(auto(LIGHT_SHELL_SETUP)).toBe('light')
    for (const [name, sample] of Object.entries(LIGHT_SHELL_SAMPLES)) {
      expect(auto(sample), `${name}: ${sample}`).toBe('light')
    }
  })
})
