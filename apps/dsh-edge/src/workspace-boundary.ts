/**
 * Records filesystem accesses outside /workspace made through the workspace
 * stub the Dynamic Worker shell uses.
 *
 * The lightweight shell's filesystem holds only /workspace, so a command that
 * touches any other path (`test -f /etc/x`, `ls /`, `cat ~/.bashrc`) is asking
 * for the Linux container's filesystem. Some of those fail loudly, but probes
 * such as `test -f` or sed's `r` answer "missing" silently; recording the
 * access itself catches both.
 */

import { RpcTarget } from 'cloudflare:workers'

const SHARED_ROOT = '/workspace'

/** Directories just-bash searches for every command name before its own registry. */
const PATH_DIRECTORIES = new Set(['/usr/bin', '/bin'])
/** Ignore files ripgrep reads from each ancestor of the search root, up to `/`. */
const ROOT_IGNORE_FILES = new Set(['/.gitignore', '/.ignore', '/.rgignore'])
/** Metadata lookups a PATH search uses (`sort > out` resolves with `statOrNull`). */
const LOOKUP_OPS = new Set(['exists', 'stat', 'statOrNull', 'lstat', 'lstatOrNull'])
/** Devices both shells provide; kept in step with the router's list. */
const SHARED_DEVICES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/zero'])

/**
 * Counts accesses outside /workspace that a light command would not make on
 * its own, so a caller can ask whether one happened while a command ran.
 * The count covers every shell sharing the workspace; a concurrent command's
 * access can only turn a light result into a rerun, never the reverse.
 */
export class WorkspaceBoundaryRecorder {
  private count = 0

  constructor(private readonly lightCommands: ReadonlySet<string>) {}

  /** A position to compare against after a command finishes. */
  mark(): number {
    return this.count
  }

  /** Whether a boundary crossing happened after `mark`. */
  crossedSince(mark: number): boolean {
    return this.count > mark
  }

  record(op: string, path: unknown): void {
    if (typeof path === 'string' && crossesBoundary(op, path, this.lightCommands)) this.count += 1
  }
}

/**
 * Whether a workspace call from the lightweight shell reaches for the Linux
 * container's filesystem. Measured in the Dynamic Worker shell: a working
 * light command only looks itself up on PATH, lets ripgrep read the root
 * ignore files, and uses the standard devices. Looking up any other program
 * means the command tried to start one the light shell lacks (awk's
 * `"cmd" | getline` does this silently).
 */
export function crossesBoundary(op: string, path: string, lightCommands: ReadonlySet<string>): boolean {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '..') segments.pop()
    else if (segment !== '' && segment !== '.') segments.push(segment)
  }
  const normalized = `/${segments.join('/')}`
  if (normalized === SHARED_ROOT || normalized.startsWith(`${SHARED_ROOT}/`)) return false
  if (SHARED_DEVICES.has(normalized)) return false
  if (op === 'readFile' && ROOT_IGNORE_FILES.has(normalized)) return false
  if (LOOKUP_OPS.has(op)) {
    if (PATH_DIRECTORIES.has(normalized)) return false
    const directory = normalized.slice(0, normalized.lastIndexOf('/'))
    if (PATH_DIRECTORIES.has(directory)) return !lightCommands.has(normalized.slice(directory.length + 1))
  }
  return true
}

type Filesystem = Record<string, (...args: unknown[]) => unknown> & { [Symbol.dispose]?: () => void }

/** The workspace stub's filesystem with every path argument recorded first. */
class RecordingFilesystemStub extends RpcTarget {
  constructor(private readonly fs: Filesystem, private readonly recorder: WorkspaceBoundaryRecorder) {
    super()
  }

  [Symbol.dispose](): void { this.fs[Symbol.dispose]?.() }
  readFile(path: string, options?: unknown) { return this.call('readFile', [path, options], path) }
  exists(path: string) { return this.call('exists', [path], path) }
  stat(path: string) { return this.call('stat', [path], path) }
  statOrNull(path: string) { return this.call('statOrNull', [path], path) }
  lstat(path: string) { return this.call('lstat', [path], path) }
  lstatOrNull(path: string) { return this.call('lstatOrNull', [path], path) }
  readlink(path: string) { return this.call('readlink', [path], path) }
  readdir(path: string, options?: unknown) { return this.call('readdir', [path, options], path) }
  find(directory: string, pattern?: unknown, options?: unknown) {
    return this.call('find', [directory, pattern, options], directory)
  }
  ls(prefix: string) { return this.call('ls', [prefix], prefix) }
  grep(pattern: unknown, path: string, options?: unknown) { return this.call('grep', [pattern, path, options], path) }
  writeFile(path: string, content: unknown, options?: unknown) { return this.call('writeFile', [path, content, options], path) }
  mkdir(path: string, options?: unknown) { return this.call('mkdir', [path, options], path) }
  rm(path: string, options?: unknown) { return this.call('rm', [path, options], path) }
  rename(from: string, to: string) {
    this.recorder.record('rename', to)
    return this.call('rename', [from, to], from)
  }
  chmod(path: string, mode: unknown) { return this.call('chmod', [path, mode], path) }
  symlink(target: string, path: string) {
    // A link into the container's filesystem (`ln -s /etc/x link`) crosses
    // even though later reads only name the link; relative targets resolve
    // against the link's directory.
    this.recorder.record('symlink', target.startsWith('/') ? target : `${path.slice(0, path.lastIndexOf('/'))}/${target}`)
    return this.call('symlink', [target, path], path)
  }

  private call(op: string, args: unknown[], path: string): unknown {
    this.recorder.record(op, path)
    // Trailing undefined options are dropped so upstream defaults apply.
    while (args.length > 1 && args[args.length - 1] === undefined) args.pop()
    return this.fs[op]!(...args)
  }
}

type WorkspaceStubLike = {
  fs: Filesystem
  runtime: unknown
  git: unknown
  assets: unknown
  artifacts: unknown
  useThink: unknown
  [Symbol.dispose]?: () => void
}

/** The workspace stub with its filesystem recorded; everything else passes through. */
export class RecordingWorkspaceStub extends RpcTarget {
  readonly #stub: WorkspaceStubLike
  readonly #fs: RecordingFilesystemStub

  constructor(stub: WorkspaceStubLike, recorder: WorkspaceBoundaryRecorder) {
    super()
    this.#stub = stub
    this.#fs = new RecordingFilesystemStub(stub.fs, recorder)
  }

  [Symbol.dispose](): void { this.#stub[Symbol.dispose]?.() }
  get fs() { return this.#fs }
  get runtime() { return this.#stub.runtime }
  get git() { return this.#stub.git }
  get assets() { return this.#stub.assets }
  get artifacts() { return this.#stub.artifacts }
  get useThink() { return this.#stub.useThink }
}
