/** Cloudflare Computer VFS `browse` backend for the upstream `ctx.directoryPicker` seam. */

import type { Context } from '@deepseek-ai/cordis'
import {
  DirectoryPicker,
  DirectoryPickerError,
  type DirectoryPickerBrowseCapability,
} from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'

/** One directory entry as the Computer workspace filesystem reports it. */
export interface EdgeDirectoryEntry {
  name: string
  isDirectory: boolean
}

/** The subset of the Computer workspace filesystem that browsing drives. */
export interface EdgeDirectoryFiles {
  readdir(path: string): Promise<readonly EdgeDirectoryEntry[]>
  stat(path: string): Promise<{ isDirectory: boolean }>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
}

export interface EdgeDirectoryPickerConfig {
  /** Run one browse primitive against the Durable Object's Computer workspace. */
  withFiles<T>(run: (files: EdgeDirectoryFiles) => Promise<T>): Promise<T>
  /** Absolute workspace root every listing stays under; also the `home` anchor. */
  root?: string
  /** Maximum child-directory rows one listing puts on the wire. */
  maxEntries?: number
}

const DEFAULT_ROOT = '/workspace'
/** Mirrors the upstream browse backend: the bound GitHub's web UI applies to directory listings. */
const DEFAULT_MAX_ENTRIES = 1_000

/**
 * In-app directory browsing over the Computer VFS.
 *
 * The upstream browse backend serves the whole host filesystem through
 * `node:fs`; on Workers the only filesystem is the owner's `/workspace` VFS
 * reached through the Durable Object, so this backend roots the browser
 * there, refuses every path that resolves outside it, and answers each level
 * from one VFS `readdir`. Listing, hidden, bound, and failure semantics follow
 * the upstream backend so the shared browse dialog behaves the same.
 */
export class EdgeDirectoryPicker extends DirectoryPicker {
  private readonly withFiles: EdgeDirectoryPickerConfig['withFiles']
  private readonly root: string
  private readonly maxEntries: number
  private readonly browseCapability: DirectoryPickerBrowseCapability = {
    kind: 'browse',
    list: (path, signal) => this.list(path, signal),
    createDirectory: (path, name) => this.createDirectory(path, name),
  }

  constructor(ctx: Context, config: EdgeDirectoryPickerConfig) {
    super(ctx)
    this.withFiles = run => config.withFiles(run)
    this.root = normalizeRoot(config.root ?? DEFAULT_ROOT)
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error('dsh-edge: directory picker maxEntries must be a positive safe integer')
    }
  }

  /** The stable `browse` capability the upstream controller and dialog drive. */
  capability(): DirectoryPickerBrowseCapability {
    return this.browseCapability
  }

  async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    signal?.throwIfAborted()
    const target = path === undefined ? this.root : resolveWithinRoot(this.root, path)
    if (target === undefined) {
      throw new DirectoryPickerError(
        'directory-unreadable',
        path ?? this.root,
        `cannot list "${path ?? ''}": not an absolute path under ${this.root}`,
      )
    }
    let children: readonly EdgeDirectoryEntry[]
    try {
      children = await this.withFiles(files => files.readdir(target))
    } catch (error) {
      signal?.throwIfAborted()
      // The Edge materializes the workspace root lazily (before the first
      // command or file write), so a root the VFS has not created yet is an
      // empty level rather than an unreadable one.
      if (target === this.root) children = []
      else {
        throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
      }
    }
    signal?.throwIfAborted()
    const rows = children
      .filter(child => child.isDirectory)
      .map(child => child.name)
      .sort((left, right) => left.localeCompare(right))
    const truncated = rows.length > this.maxEntries
    const entries: DirectoryEntry[] = rows.slice(0, this.maxEntries).map(name => ({
      name,
      path: `${target === '/' ? '' : target}/${name}`,
      hidden: name.startsWith('.'),
    }))
    return {
      path: target,
      home: this.root,
      crumbs: directoryCrumbs(this.root, target),
      entries,
      truncated,
    }
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const parent = resolveWithinRoot(this.root, path)
    if (parent === undefined) {
      throw new DirectoryPickerError(
        'directory-create-failed',
        path,
        `cannot create under "${path}": not an absolute path under ${this.root}`,
      )
    }
    if (!isSingleSegment(name)) {
      throw new DirectoryPickerError(
        'directory-create-failed',
        `${parent === '/' ? '' : parent}/${name}`,
        `"${name}" is not a single path segment`,
      )
    }
    const target = `${parent === '/' ? '' : parent}/${name}`
    let exists = false
    try {
      exists = await this.withFiles(async files => {
        try {
          await files.stat(target)
          return true
        } catch {
          return false
        }
      })
      if (!exists) {
        await this.withFiles(async files => {
          // Creation stays non-recursive like upstream, except that the lazily
          // materialized workspace root itself may still be absent.
          if (parent === this.root) await files.mkdir(this.root, { recursive: true })
          await files.mkdir(target)
        })
        return target
      }
    } catch (error) {
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
    throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
  }
}

/** Resolve an absolute wire path under `root`, refusing relative, control-character, and escaping forms. */
export function resolveWithinRoot(root: string, path: string): string | undefined {
  if (!path.startsWith('/') || hasControlCharacter(path)) return undefined
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  const resolved = parts.length === 0 ? '/' : `/${parts.join('/')}`
  if (resolved !== root && !resolved.startsWith(root === '/' ? '/' : `${root}/`)) return undefined
  return resolved
}

/** Ancestor chain from the workspace root to `target` inclusive; the root crumb carries its full path. */
export function directoryCrumbs(root: string, target: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = [{ name: root, path: root, hidden: false }]
  if (target === root) return crumbs
  const suffix = target.slice(root === '/' ? 1 : root.length + 1)
  let current = root === '/' ? '' : root
  for (const segment of suffix.split('/')) {
    current = `${current}/${segment}`
    crumbs.push({ name: segment, path: current, hidden: false })
  }
  return crumbs
}

function normalizeRoot(root: string): string {
  const resolved = resolveWithinRoot('/', root)
  if (resolved === undefined) throw new Error('dsh-edge: directory picker root must be an absolute path')
  return resolved
}

function isSingleSegment(name: string): boolean {
  return name.trim() !== ''
    && name !== '.'
    && name !== '..'
    && !/[/\\]/u.test(name)
    && !hasControlCharacter(name)
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default EdgeDirectoryPicker
