/**
 * Differential routing corpus. The Container integration runs each command
 * twice in a container deployment, once with automatic routing and once with
 * `linux: true`, each in a fresh directory prepared by ROUTING_CORPUS_SETUP.
 * Automatic routing is correct when both give the same stdout and exit code,
 * or when it reports `lightShellMiss` (it wrote files before the miss, so it
 * was not rerun; the contract is to tell the agent, not to repeat writes).
 *
 * The commands are the review findings that static rules used to handle.
 * A new routing finding belongs here first: it needs a fix only if it fails.
 * Every command must be deterministic in the container; hidden programs use
 * `uname -s` (absent from the light shell) rather than node, which crashes
 * sporadically under amd64 emulation on arm64 development machines.
 */

export const ROUTING_CORPUS_SETUP = [
  "printf 'b\\na\\nx/y\\n' > a.txt",
  'mkdir -p src && echo s > src/s.txt',
  `printf 'BEGIN { system("uname -s") }\\n' > rules.awk`,
  "printf '1e uname -s\\n' > rules.sed",
].join(' && ')

export const ROUTING_CORPUS = Object.freeze([
  // sed runs programs (`e`) or reads and writes files outside /workspace.
  "sed 'e uname -s' a.txt",
  "printf 'x\\n' | sed '1e uname -s'",
  "sed '/x/e uname -s' a.txt",
  "sed '$e echo end' a.txt",
  "sed '1,2!e echo z' a.txt",
  "printf 'x\\n' | sed -e'euname -s'",
  "printf 'x\\n' | sed --expression='euname -s'",
  "printf 'x\\n' | sed -n -e 'p;euname -s'",
  "sed '1euname -s' a.txt",
  "script='1e uname -s'; printf 'x\\n' | sed \"$script\"",
  "printf 'x\\n' | sed '\\%x%e uname -s'",
  "sed '0~2e echo z' a.txt",
  'sed -f rules.sed a.txt',
  "printf 'x\\n' | sed 's/x/uname -s/e'",
  "printf 'x/y\\n' | sed -n 's/x\\/y/uname -s/ep'",
  "printf 'x\\n' | sed -n '1r /etc/os-release'",
  "printf 'x\\n' | sed -n '1r/etc/os-release'",
  "printf 'x\\n' | sed -n '1r/./etc/os-release'",
  "printf 'x\\n' | sed -n '1r//etc/os-release'",
  "printf 'x\\n' | sed -n '1r../../../etc/os-release'",
  "sed 'w /tmp/copy' a.txt && cat /tmp/copy",
  "sed 's/a/b/w/tmp/out' a.txt && cat /tmp/out",
  // tar compressors and helper programs. The image ships gzip only, so the
  // bzip2/xz/zstd cases pass when both runs fail the same way.
  'tar -I gzip -cf out.tgz src && tar -tzf out.tgz',
  'tar -Igzip -cf out.tar a.txt && tar -tzf out.tar',
  'tar -cIgzip -f out.tar a.txt && tar -tzf out.tar',
  'tar -cJf out.tar.xz src && tar -tJf out.tar.xz',
  'tar --zstd -cf out.tzst src && tar --zstd -tf out.tzst',
  'tar -cjf out.tar.bz2 src && tar -tjf out.tar.bz2',
  'tar cfj out.tbz a.txt && tar tfj out.tbz',
  // Other tools that start programs or lack an option in the light shell.
  'sort --compress-program=gzip a.txt',
  `awk 'BEGIN { system("uname -s") }'`,
  `awk '{ print | "sort" }' a.txt`,
  `awk 'BEGIN { "uname -s" | getline l; print "got:" l }'`,
  'awk -f rules.awk a.txt',
  "env -S 'uname -s'",
  "action=-exec; find . -maxdepth 1 -name a.txt \"$action\" uname -s ';'",
  // Paths only the container has, however they are spelled or reached.
  'cat /etc/os-release',
  'ls /usr/bin | head -3',
  'grep -c processor /proc/cpuinfo',
  'cp a.txt /tmp/a.txt && cat /tmp/a.txt',
  'cat ../../../etc/os-release',
  'cat /workspace/../etc/os-release',
  'cat /./etc/os-release',
  'cat //etc/os-release',
  'ls /',
  'cd /; cat etc/os-release',
  'env -C/etc pwd',
  "cat $'/etc/os-release'",
  'cat $"/etc/os-release"',
  `awk 'BEGIN { while ((getline l < "/etc/hostname") > 0) n++; print n }'`,
  'sort -o/tmp/out a.txt && cat /tmp/out',
  'cp -t../../../tmp a.txt && cat /tmp/a.txt',
  'd=etc; test -f /"$d"/os-release && echo linux || echo missing',
  'h=/root; test -f "$h/.bashrc" && echo found || echo none',
  // PATH directories look like the light shell's own lookups; routed statically.
  '[ -d /usr/bin ] && echo yes || echo no',
  'test -x /bin/sh && echo yes || echo no',
  'test -d /usr//bin && echo yes || echo no',
  // A tool that fails inside a pipeline whose last command succeeds.
  "printf 'ab\\n' > ab.txt && grep -P 'a(?=b)' ab.txt | cat",
  "grep -P 'x(?=/)' a.txt | cat",
  // HOME differs between the shells; routed statically.
  'cd; pwd',
  'echo ~',
  'echo "$HOME"',
  // Settings the light shell silently ignores; routed statically.
  "BASH_ENV=rules.sed bash -c 'echo ok'",
  "rg --pre 'cat' b a.txt",
  // A link into the container's filesystem, created before the probe.
  "d=etc; ln -s /\"$d\"/os-release os; test -f os && echo linux || echo missing",
])
