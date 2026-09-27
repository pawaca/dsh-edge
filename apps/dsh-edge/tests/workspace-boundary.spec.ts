import { describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ RpcTarget: class {} }))

const { RecordingWorkspaceStub, WorkspaceBoundaryRecorder, crossesBoundary } = await import('../src/workspace-boundary.ts')

const LIGHT = new Set(['cat', 'echo', 'ls', 'rg', 'sed', 'awk', 'test'])

describe('workspace boundary', () => {
  // Accesses measured in the Dynamic Worker shell while light commands ran.
  it.each([
    ['exists', '/usr/bin/cat'],
    ['exists', '/bin/cat'],
    ['exists', '/usr/bin'],
    ['statOrNull', '/usr/bin/cat'],
    ['lstat', '/bin/cat'],
    ['readFile', '/.gitignore'],
    ['readFile', '/.rgignore'],
    ['readFile', '/.ignore'],
    ['readFile', '/dev/null'],
    ['readFile', '/dev/zero'],
    ['stat', '/workspace'],
    ['readdir', '/workspace/src'],
    ['writeFile', '/workspace/./a/../b.txt'],
  ])('lets a working light command %s %s', (op, path) => {
    expect(crossesBoundary(op, path, LIGHT)).toBe(false)
  })

  // Accesses measured while silent container-only commands ran.
  it.each([
    ['exists', '/etc/os-release', 'test -f /etc/os-release'],
    ['readFile', '/etc/hostname', "sed '1r /etc/hostname'"],
    ['readFile', '/.bashrc', 'cat ~/.bashrc'],
    ['stat', '/', 'ls /'],
    ['statOrNull', '/tmp', 'ls /tmp'],
    ['exists', '/usr/bin/node', 'awk \'"node -v" | getline\''],
    ['exists', '/bin/node', 'awk \'"node -v" | getline\''],
    ['statOrNull', '/usr/bin/node', 'a lookup of a program the light shell lacks'],
    ['readFile', '/usr/bin/cat', 'reading a program file is not a lookup'],
    ['readFile', '/dev/urandom', 'head -c 5 /dev/urandom'],
    ['writeFile', '/.gitignore', 'echo x > /.gitignore'],
    ['readFile', '/workspace/../etc/passwd', 'cat /workspace/../etc/passwd'],
    ['readFile', '/workspace-other/x', 'a sibling of /workspace'],
  ])('flags %s %s (%s)', (op, path) => {
    expect(crossesBoundary(op, path, LIGHT)).toBe(true)
  })

  it('reports crossings after a mark only', () => {
    const recorder = new WorkspaceBoundaryRecorder(LIGHT)
    recorder.record('exists', '/etc/os-release')
    const mark = recorder.mark()
    expect(recorder.crossedSince(mark)).toBe(false)
    recorder.record('exists', '/usr/bin/cat')
    recorder.record('readFile', '/workspace/a.txt')
    expect(recorder.crossedSince(mark)).toBe(false)
    recorder.record('readFile', '/etc/hostname')
    expect(recorder.crossedSince(mark)).toBe(true)
  })

  it('records every filesystem call and passes the rest of the stub through', async () => {
    const recorder = new WorkspaceBoundaryRecorder(LIGHT)
    const calls: unknown[][] = []
    const fs = new Proxy({}, {
      get: (_target, op) => (...args: unknown[]) => {
        calls.push([op, ...args])
        return Promise.resolve(`${String(op)}-result`)
      },
    })
    const runtime = {}
    const stub = new RecordingWorkspaceStub(
      { fs, runtime, git: 'git', assets: undefined, artifacts: 'artifacts', useThink: false } as never,
      recorder,
    )
    const mark = recorder.mark()
    await expect(stub.fs.readFile('/workspace/a.txt', 'utf8')).resolves.toBe('readFile-result')
    await stub.fs.stat('/workspace/a.txt')
    await stub.fs.readdir('/workspace')
    // Omitted options stay omitted so upstream defaults apply.
    expect(calls).toEqual([['readFile', '/workspace/a.txt', 'utf8'], ['stat', '/workspace/a.txt'], ['readdir', '/workspace']])
    expect(recorder.crossedSince(mark)).toBe(false)
    await stub.fs.symlink('../b.txt', '/workspace/dir/link')
    await stub.fs.symlink('/workspace/a.txt', '/workspace/link')
    expect(recorder.crossedSince(mark)).toBe(false)
    await stub.fs.rename('/workspace/a.txt', '/tmp/a.txt')
    expect(recorder.crossedSince(mark)).toBe(true)
    const linked = recorder.mark()
    await stub.fs.symlink('/etc/os-release', '/workspace/os')
    expect(recorder.crossedSince(linked)).toBe(true)
    const relative = recorder.mark()
    await stub.fs.symlink('../../etc/passwd', '/workspace/dir/p')
    expect(recorder.crossedSince(relative)).toBe(true)
    expect(stub.runtime).toBe(runtime)
    expect(stub.git).toBe('git')
    expect(stub.artifacts).toBe('artifacts')
    expect(stub.useThink).toBe(false)
  })

  it('follows links only when a lookup finds nothing, flagging those that leave /workspace', async () => {
    const recorder = new WorkspaceBoundaryRecorder(LIGHT)
    const links: Record<string, string> = { '/workspace/os': '/etc/os-release', '/workspace/etcdir': '../../etc' }
    const readlinks: string[] = []
    const missing = () => Object.assign(new Error('no such file'), { code: 'ENOENT' })
    const fs = {
      exists: (path: string) => Promise.resolve(path === '/workspace/a.txt'),
      statOrNull: () => Promise.resolve(null),
      stat: () => Promise.reject(missing()),
      readFile: () => Promise.reject(missing()),
      readlink: (path: string) => {
        readlinks.push(path)
        return path in links ? Promise.resolve(links[path]) : Promise.reject(missing())
      },
    }
    const stub = new RecordingWorkspaceStub({ fs, runtime: {}, git: {}, assets: undefined, artifacts: {}, useThink: false } as never, recorder)

    let mark = recorder.mark()
    await expect(stub.fs.exists('/workspace/a.txt')).resolves.toBe(true)
    expect(readlinks).toEqual([])
    await expect(stub.fs.exists('/workspace/missing.txt')).resolves.toBe(false)
    expect(recorder.crossedSince(mark)).toBe(false)

    mark = recorder.mark()
    await expect(stub.fs.exists('/workspace/os')).resolves.toBe(false)
    expect(recorder.crossedSince(mark)).toBe(true)

    mark = recorder.mark()
    await expect(stub.fs.readFile('/workspace/etcdir/os-release')).rejects.toThrow('no such file')
    expect(recorder.crossedSince(mark)).toBe(true)
  })

  it('resolves link chains, ancestor links under lstat and readlink, and loops', async () => {
    const recorder = new WorkspaceBoundaryRecorder(LIGHT)
    const links: Record<string, string> = {
      '/workspace/alias': 'external',
      '/workspace/external': '/etc',
      '/workspace/root': '/',
      '/workspace/loop-a': 'loop-b',
      '/workspace/loop-b': 'loop-a',
      '/workspace/inside': 'src',
    }
    const missing = () => Object.assign(new Error('no such file'), { code: 'ENOENT' })
    const fs = {
      exists: () => Promise.resolve(false),
      lstatOrNull: () => Promise.resolve(null),
      readlink: (path: string) => path in links ? Promise.resolve(links[path]) : Promise.reject(missing()),
    }
    const stub = new RecordingWorkspaceStub({ fs, runtime: {}, git: {}, assets: undefined, artifacts: {}, useThink: false } as never, recorder)
    const crosses = async (run: () => Promise<unknown>) => {
      const mark = recorder.mark()
      await run().catch(() => undefined)
      return recorder.crossedSince(mark)
    }
    // A PATH lookup that misses stays a benign lookup, not a link resolution.
    expect(await crosses(() => stub.fs.exists('/usr/bin/cat'))).toBe(false)
    expect(await crosses(() => stub.fs.exists('/bin/cat'))).toBe(false)
    // Two hops: alias -> external -> /etc.
    expect(await crosses(() => stub.fs.exists('/workspace/alias/os-release'))).toBe(true)
    // readlink and lstat do not follow the final link, but do follow ancestors.
    expect(await crosses(() => stub.fs.readlink('/workspace/root/tmp/edge-target'))).toBe(true)
    expect(await crosses(() => stub.fs.lstatOrNull('/workspace/root/tmp/x'))).toBe(true)
    expect(await crosses(() => stub.fs.lstatOrNull('/workspace/external'))).toBe(false)
    // Links that stay inside, and loops, are not crossings.
    expect(await crosses(() => stub.fs.exists('/workspace/inside/missing.ts'))).toBe(false)
    expect(await crosses(() => stub.fs.exists('/workspace/loop-a/x'))).toBe(false)
  })
})
