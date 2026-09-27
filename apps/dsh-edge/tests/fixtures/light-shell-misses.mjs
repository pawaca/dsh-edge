/**
 * Commands the lightweight shell cannot run, one per diagnostic that
 * `lightShellCouldNotRun` recognizes. The session integration runs each in
 * both Worker shells after LIGHT_SHELL_MISS_SETUP and asserts the classifier
 * still recognizes the result, so a just-bash or Cloudflare Computer upgrade
 * that changes a diagnostic fails the build instead of disabling the rerun.
 * `modes` limits a sample to the shells that produce it.
 */

export const LIGHT_SHELL_MISS_SETUP = 'printf "b\\na\\n" > a.txt'

export const LIGHT_SHELL_MISSES = Object.freeze([
  { name: 'missing program', command: 'node -v' },
  { name: 'program unavailable in Workers', command: 'python3 -c 1' },
  { name: 'sed e command', command: "printf 'x\\n' | sed 'e echo hi'" },
  { name: 'awk system()', command: `awk 'BEGIN { system("ls") }'` },
  { name: 'tar bzip2 codec', command: 'tar -cjf t.tbz a.txt && tar -tjf t.tbz', modes: ['isolated'] },
  { name: 'tar xz codec', command: 'tar -cJf t.txz a.txt', modes: ['isolated'] },
  { name: 'tar zstd codec', command: 'tar --zstd -cf t.tzst a.txt', modes: ['isolated'] },
  { name: 'tar in-process', command: 'tar -tf t.tar', modes: ['direct'] },
  { name: 'git without a client', command: 'git --version' },
  { name: 'unsupported option', command: "env -S 'true'" },
  { name: 'Linux path', command: 'cat /etc/os-release' },
  { name: 'relative Linux path', command: 'cat ../../etc/passwd' },
  { name: 'Linux path in a pipeline', command: 'head -c 5 /dev/urandom | wc -c' },
  { name: 'write outside the workspace', command: 'echo x > /tmp/probe' },
])
