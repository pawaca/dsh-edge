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

  /** Count a crossing established by resolving links rather than by one path argument. */
  recordCrossing(): void {
    this.count += 1
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
  const normalized = `/${normalizedSegments(path).join('/')}`
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

function normalizedSegments(path: string): string[] {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '..') segments.pop()
    else if (segment !== '' && segment !== '.') segments.push(segment)
  }
  return segments
}

/** Whether a readdir result is the light filesystem's root: one `workspace` entry. */
function listsLightRoot(entries: unknown): boolean {
  if (!Array.isArray(entries) || entries.length !== 1) return false
  const entry = entries[0] as unknown
  const name = typeof entry === 'string' ? entry : (entry as { name?: unknown } | null)?.name
  return name === 'workspace'
}

function rawSegments(path: string): string[] {
  return path.split('/').filter(segment => segment !== '')
}

function isMissing(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null
  return e?.code === 'ENOENT' || (typeof e?.message === 'string' && /ENOENT|no such/iu.test(e.message))
}

/**
 * The light filesystem's root listing (normally just `workspace`). A command
 * that changes it wrote outside /workspace through some path the boundary
 * could not see, such as a link to `/`.
 */
export async function lightRootListing(fs: { readdir(path: string): Promise<unknown> }): Promise<string> {
  try {
    const entries = await fs.readdir('/')
    if (!Array.isArray(entries)) return ''
    return entries.map(entry => typeof entry === 'string' ? entry : String((entry as { name?: unknown }).name))
      .sort().join('\0')
  } catch {
    return ''
  }
}

type Filesystem = Record<string, (...args: unknown[]) => unknown> & { [Symbol.dispose]?: () => void }

/** The workspace stub's filesystem with every path argument recorded first. */
class RecordingFilesystemStub extends RpcTarget {
  constructor(private readonly fs: Filesystem, private readonly recorder: WorkspaceBoundaryRecorder) {
    super()
  }

  [Symbol.dispose](): void { this.fs[Symbol.dispose]?.() }
  readFile(path: string, options?: unknown) { return this.probe('readFile', [path, options], path) }
  exists(path: string) { return this.probe('exists', [path], path) }
  stat(path: string) { return this.probe('stat', [path], path) }
  statOrNull(path: string) { return this.probe('statOrNull', [path], path) }
  lstat(path: string) { return this.probe('lstat', [path], path, false) }
  lstatOrNull(path: string) { return this.probe('lstatOrNull', [path], path, false) }
  readlink(path: string) { return this.probe('readlink', [path], path, false) }
  readdir(path: string, options?: unknown) { return this.probe('readdir', [path, options], path) }
  find(directory: string, pattern?: unknown, options?: unknown) {
    return this.call('find', [directory, pattern, options], directory)
  }
  ls(prefix: string) { return this.call('ls', [prefix], prefix) }
  grep(pattern: unknown, path: string, options?: unknown) { return this.call('grep', [pattern, path, options], path) }
  writeFile(path: string, content: unknown, options?: unknown) {
    return this.mutate('writeFile', [path, content, options], path)
  }
  mkdir(path: string, options?: unknown) { return this.mutate('mkdir', [path, options], path) }
  rm(path: string, options?: unknown) { return this.mutate('rm', [path, options], path, true) }
  rename(from: string, to: string) {
    this.recorder.record('rename', to)
    return this.mutate('rename', [from, to], from)
  }
  chmod(path: string, mode: unknown) { return this.mutate('chmod', [path, mode], path) }
  symlink(target: string, path: string) {
    // A link into the container's filesystem (`ln -s /etc/x link`) crosses
    // even though later reads only name the link; relative targets resolve
    // against the link's directory.
    this.recorder.record('symlink', target.startsWith('/') ? target : `${path.slice(0, path.lastIndexOf('/'))}/${target}`)
    return this.call('symlink', [target, path], path)
  }

  /**
   * A lookup that finds nothing may have gone through a link (possibly made
   * earlier by a container command) into the container's filesystem:
   * `test -f os` where `os -> /etc/os-release`, or a chain of links. Only
   * then is the path resolved, so ordinary lookups cost nothing extra.
   * `followLast` is false for operations that do not follow a final link
   * (`lstat`, `readlink`).
   */
  private async probe(op: string, args: unknown[], path: string, followLast = true): Promise<unknown> {
    let result: unknown
    try {
      result = await this.call(op, args, path)
    } catch (error) {
      if (isMissing(error) && await this.escapesThroughLinks(path, followLast)) this.recorder.recordCrossing()
      throw error
    }
    if ((result === false || result === null) && await this.escapesThroughLinks(path, followLast)) {
      this.recorder.recordCrossing()
    }
    // Outside /workspace only `/` exists in the light filesystem, so a link
    // to it (`root -> /`) dereferences successfully; listing it shows the
    // light root (just `workspace`) instead of the container's. A listing of
    // that shape counts only once resolution confirms the path left.
    if (op === 'readdir' && listsLightRoot(result) && normalizedSegments(path).length > 0
      && await this.escapesThroughLinks(path, true)) {
      this.recorder.recordCrossing()
    }
    return result
  }

  /**
   * A mutation through a link into the container's filesystem either fails
   * (its parent is missing in the light shell) or, for `rm -f`, succeeds
   * without touching anything. Failures resolve the path's links; `rm`
   * always does, since `-f` hides the miss. The final link is not followed:
   * removing or renaming a link acts on the link itself.
   */
  private async mutate(op: string, args: unknown[], path: string, always = false): Promise<unknown> {
    let result: unknown
    try {
      result = await this.call(op, args, path)
    } catch (error) {
      if (await this.escapesThroughLinks(path, false)) this.recorder.recordCrossing()
      throw error
    }
    if (always && await this.escapesThroughLinks(path, false)) this.recorder.recordCrossing()
    return result
  }

  /**
   * Resolve a /workspace path the way the kernel does, component by
   * component and link by link, and report whether any step leaves
   * /workspace. Resolution stops after 40 links, as Linux does (ELOOP fails
   * the same way in both shells).
   */
  private async escapesThroughLinks(path: string, followLast: boolean): Promise<boolean> {
    // Paths outside /workspace were already classified by `record` (PATH
    // lookups there miss on every command and must stay benign).
    if (normalizedSegments(path)[0] !== 'workspace') return false
    // Components stay raw so `..` applies after a link expands, as in the
    // kernel: `link/../passwd` with `link -> /etc/ssl` is `/etc/passwd`.
    let pending = rawSegments(path)
    let resolved: string[] = []
    for (let links = 0; pending.length > 0;) {
      const [segment, ...rest] = pending
      pending = rest
      if (segment === '.') continue
      if (segment === '..') {
        resolved.pop()
        // Climbing to or past the root leaves /workspace too.
        if (resolved[0] !== 'workspace') return true
        continue
      }
      const candidate = [...resolved, segment!]
      if (candidate[0] !== 'workspace') return true
      if (pending.length === 0 && !followLast) return false
      let target: unknown
      try {
        target = await this.fs.readlink!(`/${candidate.join('/')}`)
      } catch {
        resolved = candidate
        continue
      }
      if (typeof target !== 'string' || ++links > 40) return false
      // Continue from the root or the link's directory with the rest of the path.
      if (target.startsWith('/')) resolved = []
      pending = [...rawSegments(target), ...pending]
    }
    return resolved[0] !== 'workspace'
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
