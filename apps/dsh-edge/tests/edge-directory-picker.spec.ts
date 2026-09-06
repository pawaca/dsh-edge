import { Context } from '@deepseek-ai/cordis'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import { describe, expect, it } from 'vitest'
import {
  EdgeDirectoryPicker,
  directoryCrumbs,
  resolveWithinRoot,
  type EdgeDirectoryEntry,
} from '../src/edge-directory-picker.ts'

function dir(name: string): EdgeDirectoryEntry {
  return { name, isDirectory: true }
}

function file(name: string): EdgeDirectoryEntry {
  return { name, isDirectory: false }
}

async function backend(
  tree: Record<string, EdgeDirectoryEntry[]>,
  options: { maxEntries?: number; root?: string; failMkdir?: string } = {},
) {
  const ctx = new Context()
  const calls: string[] = []
  const files = {
    readdir: (path: string) => {
      calls.push(`readdir ${path}`)
      const entries = tree[path]
      return entries === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(entries)
    },
    stat: (path: string) => {
      calls.push(`stat ${path}`)
      const parent = path.slice(0, path.lastIndexOf('/')) || '/'
      const name = path.slice(path.lastIndexOf('/') + 1)
      const entry = tree[parent]?.find(candidate => candidate.name === name)
      return entry === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve({ isDirectory: entry.isDirectory })
    },
    mkdir: (path: string, mkdirOptions?: { recursive?: boolean }) => {
      calls.push(`mkdir ${path}${mkdirOptions?.recursive === true ? ' recursive' : ''}`)
      if (path === options.failMkdir) return Promise.reject(new Error('EACCES: read-only'))
      if (mkdirOptions?.recursive === true) {
        tree[path] ??= []
        return Promise.resolve()
      }
      const parent = path.slice(0, path.lastIndexOf('/')) || '/'
      const name = path.slice(path.lastIndexOf('/') + 1)
      const siblings = tree[parent]
      if (siblings === undefined) return Promise.reject(new Error(`ENOENT: ${parent}`))
      siblings.push(dir(name))
      tree[path] = []
      return Promise.resolve()
    },
  }
  await ctx.plugin(EdgeDirectoryPicker, {
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.root === undefined ? {} : { root: options.root }),
    withFiles: run => run(files),
  })
  const capability = ctx.directoryPicker.capability()
  if (capability.kind !== 'browse') throw new Error('expected the browse capability')
  return { ctx, calls, picker: ctx.directoryPicker, capability }
}

async function failure(promise: Promise<unknown>): Promise<DirectoryPickerError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DirectoryPickerError) return error
    throw error
  }
  throw new Error('expected a DirectoryPickerError')
}

describe('EdgeDirectoryPicker', () => {
  it('registers a stable browse capability on ctx.directoryPicker', async () => {
    const { picker, capability } = await backend({ '/workspace': [] })
    expect(capability.kind).toBe('browse')
    expect(picker.capability()).toBe(capability)
  })

  it('lists the workspace root as home when no path is given', async () => {
    const { capability, calls } = await backend({
      '/workspace': [dir('src'), file('README.md'), dir('.git'), dir('Docs')],
    })
    const listing = await capability.list()
    expect(calls).toEqual(['readdir /workspace'])
    expect(listing).toEqual({
      path: '/workspace',
      home: '/workspace',
      crumbs: [{ name: '/workspace', path: '/workspace', hidden: false }],
      entries: [
        { name: '.git', path: '/workspace/.git', hidden: true },
        { name: 'Docs', path: '/workspace/Docs', hidden: false },
        { name: 'src', path: '/workspace/src', hidden: false },
      ],
      truncated: false,
    })
  })

  it('lists a nested level with its ancestry crumbs', async () => {
    const { capability } = await backend({
      '/workspace/src/lib': [dir('b'), dir('a')],
    })
    const listing = await capability.list('/workspace/src/lib/')
    expect(listing.path).toBe('/workspace/src/lib')
    expect(listing.crumbs).toEqual([
      { name: '/workspace', path: '/workspace', hidden: false },
      { name: 'src', path: '/workspace/src', hidden: false },
      { name: 'lib', path: '/workspace/src/lib', hidden: false },
    ])
    expect(listing.entries.map(entry => entry.name)).toEqual(['a', 'b'])
  })

  it('bounds one level at maxEntries and reports the cut', async () => {
    const { capability } = await backend({
      '/workspace': [dir('c'), dir('a'), dir('b')],
    }, { maxEntries: 2 })
    const listing = await capability.list('/workspace')
    expect(listing.entries.map(entry => entry.name)).toEqual(['a', 'b'])
    expect(listing.truncated).toBe(true)
  })

  it('refuses relative, escaping, and control-character paths as unreadable', async () => {
    const { capability, calls } = await backend({ '/workspace': [], '/': [dir('etc')] })
    for (const path of ['src', '/', '/etc', '/workspace/../etc', '/workspace/a\u0000b']) {
      const error = await failure(capability.list(path))
      expect(error.code).toBe('directory-unreadable')
      expect(error.path).toBe(path)
    }
    expect(calls).toEqual([])
  })

  it('treats a workspace root the VFS has not materialized yet as an empty level', async () => {
    const { capability, calls } = await backend({})
    const listing = await capability.list()
    expect(calls).toEqual(['readdir /workspace'])
    expect(listing.entries).toEqual([])
    expect(listing.truncated).toBe(false)
    expect(listing.crumbs).toEqual([{ name: '/workspace', path: '/workspace', hidden: false }])
  })

  it('materializes the workspace root before creating a child directly under it', async () => {
    const calls: string[] = []
    const ctx = new Context()
    await ctx.plugin(EdgeDirectoryPicker, {
      withFiles: run => run({
        readdir: () => Promise.reject(new Error('ENOENT')),
        stat: (path: string) => { calls.push(`stat ${path}`); return Promise.reject(new Error('ENOENT')) },
        mkdir: (path: string, options?: { recursive?: boolean }) => {
          calls.push(`mkdir ${path}${options?.recursive === true ? ' recursive' : ''}`)
          return Promise.resolve()
        },
      }),
    })
    const capability = ctx.directoryPicker.capability()
    if (capability.kind !== 'browse') throw new Error('expected the browse capability')
    await expect(capability.createDirectory('/workspace', 'first')).resolves.toBe('/workspace/first')
    expect(calls).toEqual(['stat /workspace/first', 'mkdir /workspace recursive', 'mkdir /workspace/first'])
    calls.length = 0
    await expect(capability.createDirectory('/workspace/first', 'nested')).resolves.toBe('/workspace/first/nested')
    expect(calls).toEqual(['stat /workspace/first/nested', 'mkdir /workspace/first/nested'])
  })

  it('reports an unreadable target instead of failing the request', async () => {
    const { capability } = await backend({ '/workspace': [] })
    const error = await failure(capability.list('/workspace/missing'))
    expect(error.code).toBe('directory-unreadable')
    expect(error.path).toBe('/workspace/missing')
    expect(error.message).toContain('ENOENT')
  })

  it('rejects with the abort reason instead of a listing', async () => {
    const { capability, calls } = await backend({ '/workspace': [dir('src')] })
    const controller = new AbortController()
    controller.abort(new Error('caller left'))
    await expect(capability.list('/workspace', controller.signal)).rejects.toThrow('caller left')
    expect(calls).toEqual([])
  })

  it('creates one child directory and returns its absolute path', async () => {
    const tree = { '/workspace': [dir('src')] }
    const { capability, calls } = await backend(tree)
    await expect(capability.createDirectory('/workspace', 'project')).resolves.toBe('/workspace/project')
    expect(calls).toEqual(['stat /workspace/project', 'mkdir /workspace recursive', 'mkdir /workspace/project'])
    expect((await capability.list('/workspace')).entries.map(entry => entry.name)).toEqual(['project', 'src'])
  })

  it('reports an existing child as directory-exists', async () => {
    const { capability, calls } = await backend({ '/workspace': [dir('src')] })
    const error = await failure(capability.createDirectory('/workspace', 'src'))
    expect(error.code).toBe('directory-exists')
    expect(error.path).toBe('/workspace/src')
    expect(calls).toEqual(['stat /workspace/src'])
  })

  it('rejects an invalid name or parent as directory-create-failed without touching the VFS', async () => {
    const { capability, calls } = await backend({ '/workspace': [] })
    for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b', 'a\u0000b']) {
      const error = await failure(capability.createDirectory('/workspace', name))
      expect(error.code).toBe('directory-create-failed')
    }
    for (const parent of ['relative', '/etc', '/workspace/../tmp']) {
      const error = await failure(capability.createDirectory(parent, 'child'))
      expect(error.code).toBe('directory-create-failed')
      expect(error.path).toBe(parent)
    }
    expect(calls).toEqual([])
  })

  it('maps a VFS creation failure onto directory-create-failed', async () => {
    const { capability } = await backend({ '/workspace': [] }, { failMkdir: '/workspace/locked' })
    const error = await failure(capability.createDirectory('/workspace', 'locked'))
    expect(error.code).toBe('directory-create-failed')
    expect(error.path).toBe('/workspace/locked')
    expect(error.message).toContain('EACCES')
    const missingParent = await failure(capability.createDirectory('/workspace/absent', 'child'))
    expect(missingParent.code).toBe('directory-create-failed')
  })

  it('rejects an invalid configuration at load', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(EdgeDirectoryPicker, {
      maxEntries: 0,
      withFiles: run => run({
        readdir: () => Promise.resolve([]),
        stat: () => Promise.reject(new Error('unused')),
        mkdir: () => Promise.resolve(),
      }),
    })).rejects.toThrow(/maxEntries/u)
  })
})

describe('resolveWithinRoot', () => {
  it('normalizes dot segments and trailing slashes under the root', () => {
    expect(resolveWithinRoot('/workspace', '/workspace')).toBe('/workspace')
    expect(resolveWithinRoot('/workspace', '/workspace/')).toBe('/workspace')
    expect(resolveWithinRoot('/workspace', '/workspace/./src/lib/../lib/')).toBe('/workspace/src/lib')
  })

  it('refuses anything that does not resolve under the root', () => {
    expect(resolveWithinRoot('/workspace', '/workspaces')).toBeUndefined()
    expect(resolveWithinRoot('/workspace', '/')).toBeUndefined()
    expect(resolveWithinRoot('/workspace', '/workspace/..')).toBeUndefined()
    expect(resolveWithinRoot('/workspace', 'workspace')).toBeUndefined()
    expect(resolveWithinRoot('/workspace', '/workspace/\u0000')).toBeUndefined()
  })
})

describe('directoryCrumbs', () => {
  it('labels the root crumb with its full path and each descendant by name', () => {
    expect(directoryCrumbs('/workspace', '/workspace/a/b')).toEqual([
      { name: '/workspace', path: '/workspace', hidden: false },
      { name: 'a', path: '/workspace/a', hidden: false },
      { name: 'b', path: '/workspace/a/b', hidden: false },
    ])
  })
})
