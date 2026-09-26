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
    await stub.fs.rename('/workspace/a.txt', '/tmp/a.txt')
    expect(recorder.crossedSince(mark)).toBe(true)
    expect(stub.runtime).toBe(runtime)
    expect(stub.git).toBe('git')
    expect(stub.artifacts).toBe('artifacts')
    expect(stub.useThink).toBe(false)
  })
})
