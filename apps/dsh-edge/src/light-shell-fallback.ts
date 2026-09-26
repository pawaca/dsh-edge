/**
 * Runtime detection of commands the lightweight shell could not run.
 *
 * Static routing predicts which commands need Linux; this module checks what
 * actually happened. just-bash and Cloudflare Computer fail loudly when a
 * command needs something the Worker lacks: exit 127 for a missing program,
 * fixed diagnostics for sandboxed features and missing native codecs, and a
 * missing-path error for anything outside /workspace (the light shell's
 * filesystem contains nothing else). A command that failed this way and wrote
 * nothing can be rerun in the container transparently, so a routing miss
 * costs one extra attempt instead of a wrong result.
 *
 * The diagnostics are just-bash and Computer strings; the isolated session
 * integration asserts each one so an upgrade that changes them fails the build.
 */

import type { EdgeShellResult } from './agent.ts'

const SHARED_ROOT = '/workspace'

/** Diagnostics for features the Worker shell lacks, independent of exit code. */
const CAPABILITY_DIAGNOSTICS: readonly RegExp[] = [
  // Programs just-bash cannot provide in a Worker (`python3`, `tar` in-process).
  /command not available in browser environments/u,
  // sed `e`, awk `system()`.
  /not supported in sandboxed environment/u,
  /shell execution not allowed in sandboxed environment/u,
  // tar bzip2 / xz / zstd native codecs.
  /is not available in this Worker/u,
  /requires node-liblzma/u,
  /requires @mongodb-js\/zstd/u,
  // Computer's git command without a configured git client.
  /Workspace git is not configured/u,
  // A Worker module the command needs is missing (`curl` in the isolated shell).
  /No such module "/u,
  // A GNU option just-bash does not implement (`env -S`, `tar -I`, `sort --compress-program`).
  /^[\w.[-]+: (?:invalid|unrecognized) option\b/mu,
]

/** Paths a command reported missing (`cat: /etc/x: No such file or directory`). */
const MISSING_PATH = /(?:^|\s)([^\s:'"]+): No such file or directory|parent directory missing: ([^\s:]+)/gu

/**
 * Whether a lightweight-shell result shows the command needed something only
 * the Linux container has. Cancelled and timed-out runs never count.
 */
export function lightShellCouldNotRun(result: EdgeShellResult, cwd: string): boolean {
  if (result.status === 'cancelled' || result.timedOut) return false
  if (result.exitCode === 127) return true
  if (CAPABILITY_DIAGNOSTICS.some(pattern => pattern.test(result.stderr))) return true
  for (const match of result.stderr.matchAll(MISSING_PATH)) {
    const path = match[1] ?? match[2]
    if (path !== undefined && !insideSharedRoot(path, cwd)) return true
  }
  return false
}

function insideSharedRoot(path: string, cwd: string): boolean {
  const resolved = path.startsWith('/') ? [] : cwd.split('/').filter(Boolean)
  for (const segment of path.split('/')) {
    if (segment === '..') resolved.pop()
    else if (segment !== '' && segment !== '.') resolved.push(segment)
  }
  return `/${resolved.join('/')}/`.startsWith(`${SHARED_ROOT}/`)
}

/**
 * The workspace VFS revision, or undefined when it cannot be read. Computer's
 * VFS increments it on every write (including `mkdir -p` of an existing
 * directory), so an unchanged revision means the command wrote nothing.
 */
export function workspaceRevision(sql: SqlStorage): number | undefined {
  try {
    const value = sql.exec<{ v: number }>("SELECT v FROM vfs_meta WHERE k = 'rev'").one().v
    return Number.isSafeInteger(Number(value)) ? Number(value) : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a command left the workspace unchanged. Concurrent writes by other
 * sessions also advance the revision; that only turns a rerun into a hint.
 */
export function leftWorkspaceUnchanged(before: number | undefined, after: number | undefined): boolean {
  return before !== undefined && after === before
}
