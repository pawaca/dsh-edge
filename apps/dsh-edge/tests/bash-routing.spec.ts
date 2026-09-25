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
    ["env -S 'ls -la'", 'container'],
    ['env -S "$CMD"', 'container'],
    ['echo "${NAME:-$(git config user.name)}"', 'container'],
    ['cat <<< "$(node -v)"', 'container'],
    ['cat <<< "$(date)"', 'light'],
    ["$'no\x64e' -v", 'container'],
  ] as const)('checks programs hidden in %s', (command, route) => {
    expect(auto(command)).toBe(route)
  })

  // Family invariant: a program the light shell lacks is never hidden by any
  // construct that can run a command, alone or nested inside another one.
  it('never routes a Linux-only program to the light shell, however it is wrapped or nested', () => {
    const carriers: Array<[string, (inner: string) => string]> = [
      ['env', c => `env ${c}`],
      ['env assignment', c => `env A=1 ${c}`],
      ['env -S', c => `env -S '${c}'`],
      ['timeout', c => `timeout 5 ${c}`],
      ['time', c => `time ${c}`],
      ['nice', c => `nice -n 5 ${c}`],
      ['nohup', c => `nohup ${c}`],
      ['exec', c => `exec ${c}`],
      ['xargs', c => `echo x | xargs ${c}`],
      ['find -exec (second action)', c => `find . -exec ls {} + -exec ${c} {} +`],
      ['bash -c', c => `bash -c '${c}'`],
      ['command substitution', c => `echo $(${c})`],
      ['backquotes', c => `echo \`${c}\``],
      ['quoted substitution', c => `echo "x $(${c})"`],
      ['process substitution in', c => `cat <(${c})`],
      ['process substitution out', c => `tee >(${c}) < a.txt`],
      ['arithmetic', c => `echo $(( $(${c}) + 1 ))`],
      ['quoted arithmetic', c => `echo "$(( $(${c}) + 1 ))"`],
      ['heredoc body', c => `cat <<EOF\n$(${c})\nEOF`],
      ['here-string', c => `cat <<< "$(${c})"`],
      ['parameter default', c => `echo "\${X:-$(${c})}"`],
      ['array literal', c => `list=($(${c}))`],
      ['if condition', c => `if ${c}; then ls; fi`],
      ['for body', c => `for f in a; do ${c}; done`],
      ['brace group', c => `{ ${c}; }`],
      ['function body', c => `f(){ ${c}; }; f`],
      ['pipeline', c => `ls | ${c}`],
    ]
    const heavy = 'node -v'
    for (const [name, wrap] of carriers) {
      expect(auto(wrap(heavy)), name).toBe('container')
      for (const [inner, innerWrap] of carriers) {
        // Unescaped backquotes cannot nest in bash (the inner pair closes the
        // outer one), so that pair does not run the program; escaped nesting
        // is covered below.
        if (name === 'backquotes' && inner === 'backquotes') continue
        expect(auto(wrap(innerWrap(heavy))), `${name} > ${inner}`).toBe('container')
      }
    }
  })

  it('treats function definitions as opaque, since they can shadow programs out of order', () => {
    expect(auto('node -v; node(){ :; }')).toBe('container')
    expect(auto('false && node(){ :; }; node -v')).toBe('container')
    expect(auto('f(){ ls; }; f')).toBe('container')
  })

  it.each([
    ["rg --pre 'node -v' needle file", 'container'],
    ['rg --pre=./decode.sh needle', 'container'],
    ['rg -n needle src', 'light'],
    ['tar -I zstd -cf out.tar.zst src', 'container'],
    ["tar --to-command='node x.js' -xf a.tar", 'container'],
    ['tar -tf a.tar', 'light'],
    ['sort --compress-program=gzip big.txt', 'container'],
    ["awk 'BEGIN { system(\"node -v\") }'", 'container'],
    ["awk '{ print | \"sort\" }' a.txt", 'container'],
    ["awk -F, '{ s += $2 } END { print s }' c.csv", 'light'],
    ["sed 'e node -v' a.txt", 'container'],
    ["printf 'x\\n' | sed '1e node -v'", 'container'],
    ["sed '/x/e node -v' a.txt", 'container'],
    ["sed '$e date' a.txt", 'container'],
    ["sed '1,3!e ls' a.txt", 'container'],
    ["sed 's/e/E/g' a.txt", 'light'],
    ["sed '/^#/d; s/e$/E/' a.txt", 'light'],
    ['type -P node', 'container'],
    ["script='1e node -v'; printf 'x\\n' | sed \"$script\"", 'container'],
    ['awk "$PROGRAM" data.txt', 'container'],
    ['rg $FLAGS needle', 'container'],
    ['tar $OPTS -xf a.tar', 'container'],
    ['sed -n "${LINE}p" a.txt', 'container'],
    ['grep "$PATTERN" a.txt', 'light'],
    ['cat "$FILE"', 'light'],
    ['rg "$(printf -- --pre)" node needle file.js', 'container'],
    ['rg "`printf -- --pre`" node needle', 'container'],
    ['echo x | xargs --process-slot-var ls node', 'container'],
    ['echo x | xargs --some-future-option ls', 'container'],
    ['timeout --unknown 5 ls', 'container'],
    ['echo a | xargs -0 -n1 -I{} cp {} out/', 'light'],
    ['echo a | xargs --max-args=1 cat', 'light'],
    ['timeout --foreground -s KILL 5 ls', 'light'],
    ['env -i FOO=1 printenv FOO', 'light'],
    // A PATH naming Linux directories means Linux programs.
    ['env -i PATH=/bin ls', 'container'],
    ['timeout -k 2 5 ls', 'light'],
    // nice is not a light-shell command itself.
    ['nice -5 ls', 'container'],
    ["bash script.sh -c 'ls'", 'container'],
    ["sh ./run.sh -c 'ls'", 'container'],
    ["bash -o pipefail -c 'ls'", 'container'],
    ["bash --rcfile x -c 'ls'", 'container'],
    ["bash -ec 'ls | wc -l'", 'light'],
    ["bash --norc -xc 'ls'", 'light'],
    ["sh -c 'cat a.txt'", 'light'],
    ["x='$(node -v)'; echo \"${x@P}\"", 'container'],
    ['x=$(cat prompt.txt); echo "${x@P}"', 'container'],
    ["x='a[$(node -v)]'; echo $((x))", 'container'],
    ['x="\\$(node -v)"; echo "$x"', 'container'],
    ["grep 'plain text' a.txt", 'light'],
    ["printf '%s\\n' --pre=node | xargs -I{} rg {} needle file", 'container'],
    ['echo --pre=node | xargs rg needle', 'container'],
    ['ls | xargs -I% sed -n 1p %', 'container'],
    ['ls | xargs wc -l', 'light'],
    ['ls | xargs -I{} cp {} out/', 'light'],
    ["env -S 'timeout 5' node -v", 'container'],
    ["env -S 'ls' -la", 'container'],
    ["printf 'x\\n' | sed '\\%x%e node -v'", 'container'],
    ["sed '2,/end/!e ls' a.txt", 'container'],
    ["sed '0~2e date' a.txt", 'container'],
    ["sed -n '/start/,/end/p' a.txt", 'light'],
    ['tar -Inode -cf out.tar a.txt', 'container'],
    ['tar -Izstd -xf a.tar.zst', 'container'],
    ["BASH_ENV=hooks.sh bash -c 'echo ok'", 'container'],
    ["export BASH_ENV=hooks.sh; sh -c 'ls'", 'container'],
    ["ENV=rc sh -c 'ls'", 'container'],
    ['cat /etc/os-release', 'container'],
    ['ls /usr/bin', 'container'],
    ['echo hi >/dev/tcp/host/80', 'container'],
    ['cat /proc/cpuinfo | head', 'container'],
    ['cp a.txt /tmp/a.txt', 'container'],
    ['ls ~/.config', 'container'],
    ['grep -r x --include=*.ts --exclude-dir=/var/cache .', 'container'],
    ['ls /workspace/src && cat /workspace/a.txt', 'light'],
    ['echo hi > /dev/null 2>&1', 'light'],
    ["sed -n '/start/,/end/p' a.txt", 'light'],
    ['tar --rsh-command=node -cf host:/tmp/a file', 'container'],
    ['tar --rmt-command=/usr/sbin/rmt -cf a.tar b', 'container'],
    ['awk -f rules.awk data.txt', 'container'],
    ['awk --file=rules.awk data.txt', 'container'],
    ['awk -F, -f rules.awk data.txt', 'container'],
    ['sed -f rules.sed a.txt', 'container'],
    ['sed -nf rules.sed a.txt', 'container'],
    ['sed --file=rules.sed a.txt', 'container'],
    ["sed -i 's/a/b/' a.txt", 'light'],
    ["awk -F: '{ print $1 }' a.txt", 'light'],
    ['type ls', 'container'],
    ["sed 's/x/node -v/e' a.txt", 'container'],
    ["sed -n '1,5p' a.txt", 'light'],
    ["sed 's/foo/bar/g' a.txt", 'light'],
  ] as const)('treats tools that start programs themselves as opaque: %s', (command, route) => {
    expect(auto(command)).toBe(route)
  })

  it('treats escaped nested backquotes as opaque', () => {
    expect(auto('echo `echo \\`node -v\\``')).toBe('container')
    expect(auto('echo "`echo \\`ls\\``"')).toBe('container')
  })

  it('routes relative paths that climb out of /workspace to the container', () => {
    const at = (cwd: string, command: string) =>
      routeBashCommand(command, { policy: 'auto', containerAvailable: true, cwd })
    expect(at('/workspace', 'cat ../etc/os-release')).toBe('container')
    expect(at('/workspace', 'cd ..; ls')).toBe('container')
    expect(at('/workspace', 'ls ..')).toBe('container')
    expect(at('/workspace/app', 'cat ../../etc/hosts')).toBe('container')
    expect(at('/workspace/app/src', 'cat ../README.md')).toBe('light')
    expect(at('/workspace/app', 'ls ../other && cd ..')).toBe('light')
    expect(at('/workspace', 'cat ./a/../b.txt')).toBe('light')
    expect(at('/workspace', 'cat /workspace/../etc/os-release')).toBe('container')
    expect(at('/workspace', 'ls /workspace/app/../..')).toBe('container')
    expect(at('/workspace', 'cat /workspace/app/../README.md')).toBe('light')
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
    expect(commandWords('timeout -s KILL 5 npm test')).toEqual(['timeout', 'npm'])
    expect(commandWords('env -u HOME A=1 node x.js')).toEqual(['env', 'node'])
    expect(commandWords('ls | xargs -n 1 -I{} cp {} out/')).toEqual(['ls', 'xargs', 'cp'])
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
