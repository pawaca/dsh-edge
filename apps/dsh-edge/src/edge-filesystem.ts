/** Computer VFS implementation of the upstream FileSystem service (`ctx.fs`). */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
} from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

interface EdgeVfs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  readFile(path: string): Promise<ReadableStream<Uint8Array>>
  writeFile(path: string, content: string | Uint8Array): Promise<void>
  stat(path: string): Promise<{
    size: number
    mtime: number
    isFile: boolean
    isDirectory: boolean
    isSymbolicLink: boolean
  }>
  lstat(path: string): Promise<{
    size: number
    mtime: number
    isFile: boolean
    isDirectory: boolean
    isSymbolicLink: boolean
  }>
  readdir(path: string): Promise<Array<{
    name: string
    size: number
    mtime: number
    isFile: boolean
    isDirectory: boolean
  }>>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
}

function resolvePath(cwd: string, path: string): string {
  if (path.startsWith('/')) return normalizePath(path)
  return normalizePath(`${cwd}/${path}`)
}

function normalizePath(path: string): string {
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { parts.pop(); continue }
    parts.push(segment)
  }
  return `/${parts.join('/')}`
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function versionOf(mtime: number, size: number): FsVersion {
  return FsVersion(`${String(mtime)}:${String(size)}`)
}

function entryType(entry: { isFile: boolean; isDirectory: boolean }): 'file' | 'directory' | 'other' {
  if (entry.isFile) return 'file'
  if (entry.isDirectory) return 'directory'
  return 'other'
}

function pathType(entry: { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }): 'file' | 'directory' | 'symlink' | 'other' {
  if (entry.isSymbolicLink) return 'symlink'
  if (entry.isFile) return 'file'
  if (entry.isDirectory) return 'directory'
  return 'other'
}

export class EdgeFileSystem extends FileSystem {
  private static storage = new AsyncLocalStorage<{ vfs: EdgeVfs; cwd: string }>()

  constructor(ctx: Context) {
    super(ctx)
  }

  bind(_vfs: EdgeVfs, _cwd: string): () => void {
    return () => { /* cleanup is handled by AsyncLocalStorage scope */ }
  }

  runInScope<T>(vfs: EdgeVfs, cwd: string, fn: () => Promise<T>): Promise<T> {
    return EdgeFileSystem.storage.run({ vfs, cwd }, fn)
  }

  private requireBinding(): { vfs: EdgeVfs; cwd: string } {
    const binding = EdgeFileSystem.storage.getStore()
    if (binding === undefined) {
      throw new FsError(
        'File operations are only available during an active turn.',
        'FS_IO_ERROR',
      )
    }
    return binding
  }

  override get sandboxMode() { return undefined }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const binding = this.requireBinding()
    const resolved = resolvePath(opts?.cwd ?? binding.cwd, path)
    return { targetKey: FsTargetKey(resolved), displayPath: resolved }
  }

  processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  fileUrl(target: FsTarget): string {
    return `file://${this.processPath(target)}`
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const parentPath = this.processPath(parent)
    const childPath = this.processPath(child)
    return childPath === parentPath || childPath.startsWith(`${parentPath}/`)
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    const vfs = this.requireBinding().vfs
    try {
      const info = await vfs.stat(this.processPath(target))
      return {
        version: versionOf(info.mtime, info.size),
        type: entryType(info),
        size: info.size,
      }
    } catch {
      return undefined
    }
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const binding = this.requireBinding()
    const resolved = resolvePath(opts?.cwd ?? binding.cwd, path)
    const vfs = binding.vfs
    try {
      const info = await vfs.lstat(resolved)
      return {
        version: versionOf(info.mtime, info.size),
        type: pathType(info),
        size: info.size,
      }
    } catch {
      return undefined
    }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new FsError('readText aborted', 'FS_ABORTED')
    const vfs = this.requireBinding().vfs
    const path = this.processPath(target)
    try {
      const content = await vfs.readFile(path, 'utf8')
      const info = await vfs.stat(path)
      const version = versionOf(info.mtime, info.size)
      this.ctx.emit('fs/observed', target, { kind: 'present', version }, undefined)
      return normalizeLineEndings(content)
    } catch (error) {
      throw new FsError(`cannot read "${target.displayPath}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR', { cause: error })
    }
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const content = await this.readText(target, signal)
    return (async function* () { yield content })()
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (signal?.aborted) throw new FsError('readBytes aborted', 'FS_ABORTED')
    const vfs = this.requireBinding().vfs
    const path = this.processPath(target)
    try {
      const stream = await (vfs as { readFile(p: string): Promise<ReadableStream<Uint8Array>> }).readFile(path)
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw new FsError(`"${target.displayPath}" exceeds the ${String(maxBytes)}-byte read limit`, 'FS_TOO_LARGE')
        }
        chunks.push(value)
      }
      const result = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
      return result
    } catch (error) {
      if (error instanceof FsError) throw error
      throw new FsError(`cannot read "${target.displayPath}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR', { cause: error })
    }
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    if (signal?.aborted) throw new FsError('listDir aborted', 'FS_ABORTED')
    const vfs = this.requireBinding().vfs
    const parentPath = this.processPath(target)
    try {
      const entries = await vfs.readdir(parentPath)
      return entries.map(entry => ({
        name: entry.name,
        type: entryType(entry),
        target: {
          targetKey: FsTargetKey(`${parentPath}/${entry.name}`),
          displayPath: `${parentPath}/${entry.name}`,
        },
        version: versionOf(entry.mtime, entry.size),
        size: entry.size,
      }))
    } catch (error) {
      throw new FsError(`cannot list "${target.displayPath}": ${error instanceof Error ? error.message : String(error)}`, 'FS_NOT_DIRECTORY', { cause: error })
    }
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    if (signal?.aborted) throw new FsError('writeText aborted', 'FS_ABORTED')
    const vfs = this.requireBinding().vfs
    const path = this.processPath(target)
    const existing = await this.stat(target)
    if (existing !== undefined && existing.type !== 'file') {
      throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
      if (existing.version !== expected.version) throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    let before: string | null = null
    if (existing !== undefined) {
      try { before = normalizeLineEndings(await vfs.readFile(path, 'utf8')) } catch { /* binary or unreadable */ }
    }
    const parentDir = path.substring(0, path.lastIndexOf('/')) || '/'
    try { await vfs.mkdir(parentDir, { recursive: true }) } catch { /* already exists */ }
    await vfs.writeFile(path, content)
    const after = await this.stat(target)
    const version = after?.version ?? versionOf(Date.now(), content.length)
    this.ctx.emit('fs/observed', target, { kind: 'present', version }, undefined)
    return {
      operation: existing !== undefined ? 'update' : 'create',
      version,
      before,
      after: normalizeLineEndings(content),
    }
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    if (signal?.aborted) throw new FsError('editText aborted', 'FS_ABORTED')
    const vfs = this.requireBinding().vfs
    const path = this.processPath(target)
    const existing = await this.stat(target)
    if (existing === undefined) throw new FsError(`cannot edit "${target.displayPath}": file not found`, 'FS_STALE_VERSION')
    if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected !== undefined && existing.version !== expected.version) {
      throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    const original = normalizeLineEndings(await vfs.readFile(path, 'utf8'))
    const oldNorm = normalizeLineEndings(edit.oldString)
    if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
    const occurrences = original.split(oldNorm).length - 1
    if (occurrences === 0) throw new FsError(`old_string was not found in "${target.displayPath}"`, 'FS_EDIT_NOT_FOUND')
    if (!edit.replaceAll && occurrences > 1) {
      throw new FsError(`old_string matched ${String(occurrences)} times in "${target.displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
    }
    const newNorm = normalizeLineEndings(edit.newString)
    const edited = original.split(oldNorm).join(newNorm)
    await vfs.writeFile(path, edited)
    const afterInfo = await this.stat(target)
    const version = afterInfo?.version ?? versionOf(Date.now(), edited.length)
    this.ctx.emit('fs/observed', target, { kind: 'present', version }, undefined)
    return { version, before: original, after: edited }
  }
}
