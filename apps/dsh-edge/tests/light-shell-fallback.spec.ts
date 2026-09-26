import { describe, expect, it } from 'vitest'
import type { EdgeShellResult } from '../src/agent.ts'
import { leftWorkspaceUnchanged, lightShellCouldNotRun } from '../src/light-shell-fallback.ts'

function result(overrides: Partial<EdgeShellResult>): EdgeShellResult {
  return {
    executionId: 'e' as EdgeShellResult['executionId'],
    status: 'failed',
    timedOut: false,
    exitCode: 1,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    ...overrides,
  }
}

describe('light shell miss detection', () => {
  it.each([
    ['a missing program', { exitCode: 127, stderr: 'bash: node: command not found\n' }],
    ['a program unavailable in Workers', {
      exitCode: 127,
      stderr: "bash: python3: command not available in browser environments. Exclude 'python3' from your commands or use the Node.js bundle.\n",
    }],
    ['sed e', { stderr: 'sed: e command (shell execution) is not supported in sandboxed environment\n' }],
    ['awk system()', {
      exitCode: 2,
      stderr: 'awk: system() is not supported - shell execution not allowed in sandboxed environment\n',
    }],
    ['a tar codec', {
      exitCode: 2,
      stderr: 'tar: bzip2 decompression is not available in this Worker — the seek-bzip native module is not loadable inside workerd.\n',
    }],
    ['tar xz', { exitCode: 2, stderr: 'tar: error creating archive: xz compression requires node-liblzma which failed to load.\n' }],
    ['tar zstd', { exitCode: 2, stderr: 'tar: error creating archive: zstd compression requires @mongodb-js/zstd which is not installed.\n' }],
    ['git without a client', { stderr: 'git: Workspace git is not configured. Import createGitClient …\n' }],
    ['a missing Worker module', { stderr: 'curl: No such module "chunk-BO4NKWMI.js".\n' }],
    ['an unsupported option', { stderr: "env: invalid option -- 'S'\n" }],
    ['an unrecognized long option', { stderr: "sort: unrecognized option '--compress-program=gzip'\n" }],
    ['a Linux path', { stderr: 'cat: /etc/os-release: No such file or directory\n' }],
    ['a home path', { stderr: 'cat: //.bashrc: No such file or directory\n' }],
    ['a Linux path in a pipeline that exits 0', {
      status: 'completed' as const, exitCode: 0, stdout: '0\n', stderr: 'head: /dev/urandom: No such file or directory\n',
    }],
    ['a write outside the workspace', { stderr: 'parent directory missing: /tmp/probe: /tmp/probe\n' }],
  ])('recognizes %s', (_name, overrides) => {
    expect(lightShellCouldNotRun(result(overrides), '/workspace')).toBe(true)
  })

  it('resolves relative missing paths against the working directory', () => {
    const missing = (path: string) => result({ stderr: `cat: ${path}: No such file or directory\n` })
    expect(lightShellCouldNotRun(missing('../../etc/passwd'), '/workspace/app')).toBe(true)
    expect(lightShellCouldNotRun(missing('../notes.txt'), '/workspace/app')).toBe(false)
    expect(lightShellCouldNotRun(missing('missing.txt'), '/workspace')).toBe(false)
    expect(lightShellCouldNotRun(missing('/workspace/missing.txt'), '/workspace')).toBe(false)
    expect(lightShellCouldNotRun(missing('/workspace-other/x'), '/workspace')).toBe(true)
  })

  it('leaves ordinary failures, cancellations, and timeouts in the light shell', () => {
    expect(lightShellCouldNotRun(result({ stderr: 'grep: pattern not found\n' }), '/workspace')).toBe(false)
    expect(lightShellCouldNotRun(result({ exitCode: 2, stderr: 'diff: files differ\n' }), '/workspace')).toBe(false)
    expect(lightShellCouldNotRun(result({ status: 'cancelled', exitCode: 127 }), '/workspace')).toBe(false)
    expect(lightShellCouldNotRun(result({ timedOut: true, exitCode: 127 }), '/workspace')).toBe(false)
    expect(lightShellCouldNotRun(result({ status: 'completed', exitCode: 0 }), '/workspace')).toBe(false)
  })

  it('treats the workspace as unchanged only when the revision did not move', () => {
    expect(leftWorkspaceUnchanged(7, 7)).toBe(true)
    expect(leftWorkspaceUnchanged(7, 8)).toBe(false)
    expect(leftWorkspaceUnchanged(undefined, undefined)).toBe(false)
    expect(leftWorkspaceUnchanged(7, undefined)).toBe(false)
  })
})
