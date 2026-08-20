import { describe, expect, it, vi } from 'vitest'
import {
  DIRECT_SHELL_OUTPUT_TRUNCATED,
  EDGE_SHELL_OUTPUT_LIMIT_BYTES,
} from '../src/direct-shell-protocol.ts'
import {
  executeWorkspaceCommand,
  MAX_TEXT_FILE_BYTES,
  readBoundedWorkspaceFile,
  resolveEdgeCommandTimeoutPolicy,
  type EdgeWorkspace,
} from '../src/workspace.ts'

describe('dsh-edge workspace file reads', () => {
  it('rejects an oversized entry before opening its contents', async () => {
    const stat = vi.fn().mockResolvedValue({ size: MAX_TEXT_FILE_BYTES + 1 })
    const readFile = vi.fn()

    await expect(readBoundedWorkspaceFile({ stat, readFile }, '/workspace/large.txt'))
      .rejects.toMatchObject({ status: 413 })
    expect(stat).toHaveBeenCalledWith('/workspace/large.txt')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('rejects a file that grows after the metadata check', async () => {
    const stat = vi.fn().mockResolvedValue({ size: 1 })
    const first = new Uint8Array(MAX_TEXT_FILE_BYTES)
    const overflow = new Uint8Array([1])
    const readFile = vi.fn().mockResolvedValue(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first)
        controller.enqueue(overflow)
        controller.close()
      },
    }))

    await expect(readBoundedWorkspaceFile({ stat, readFile }, '/workspace/growing.txt'))
      .rejects.toMatchObject({ status: 413 })
    expect(readFile).toHaveBeenCalledWith('/workspace/growing.txt')
  })
})

describe('dsh-edge workspace command execution', () => {
  it('validates deployment timeout defaults and ceilings', () => {
    expect(resolveEdgeCommandTimeoutPolicy()).toEqual({
      defaultTimeoutMs: 120_000,
      maxTimeoutMs: 120_000,
    })
    expect(resolveEdgeCommandTimeoutPolicy('180000', '240000')).toEqual({
      defaultTimeoutMs: 180_000,
      maxTimeoutMs: 240_000,
    })
    expect(() => resolveEdgeCommandTimeoutPolicy('0', '120000')).toThrow(/positive integer/)
    expect(() => resolveEdgeCommandTimeoutPolicy('120001', '120000')).toThrow(/no greater/)
    expect(() => resolveEdgeCommandTimeoutPolicy('120000', '2147483648')).toThrow(/2147483647/)
  })

  it('treats a conventional signal exit code as failed without an adapter interrupt', async () => {
    const runtime = executionRuntime([{ name: 'exit', code: 130 }])

    const result = await executeWorkspaceCommand(
      runtime.workspace,
      'exit 130',
      '/workspace',
      resolveEdgeCommandTimeoutPolicy(),
    )

    expect(result.status).toBe('failed')
    expect(result.timedOut).toBe(false)
    expect(runtime.mkdir).toHaveBeenCalledWith('/workspace', { recursive: true })
    expect(runtime.exec).toHaveBeenCalledWith('exit 130', {
      cwd: '/workspace',
      timeoutMs: 120_000,
    })
    expect(runtime.kill).not.toHaveBeenCalled()
  })

  it('reports cancellation when its abort handler interrupts a clean exit', async () => {
    const abort = new AbortController()
    const runtime = executionRuntime(
      [{ name: 'exit', code: 0 }],
      () => { abort.abort() },
    )

    const result = await executeWorkspaceCommand(
      runtime.workspace,
      'trap-exit-zero',
      '/workspace',
      resolveEdgeCommandTimeoutPolicy(),
      undefined,
      abort.signal,
    )

    expect(result.status).toBe('cancelled')
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(runtime.kill).toHaveBeenCalledWith('SIGINT')
  })

  it('rejects a caller timeout above the deployment ceiling before execution', async () => {
    const runtime = executionRuntime([{ name: 'exit', code: 0 }])

    await expect(executeWorkspaceCommand(
      runtime.workspace,
      'true',
      '/workspace',
      resolveEdgeCommandTimeoutPolicy('1000', '2000'),
      2001,
    )).rejects.toMatchObject({ status: 400 })
    expect(runtime.exec).not.toHaveBeenCalled()
  })

  it('reports the configured deadline independently from exit status', async () => {
    const runtime = executionRuntime([{ name: 'exit', code: 124 }], undefined, 10)

    const result = await executeWorkspaceCommand(
      runtime.workspace,
      'long-running-command',
      '/workspace',
      resolveEdgeCommandTimeoutPolicy('1', '10'),
    )

    expect(result.status).toBe('failed')
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(124)
  })

  it('preserves direct-shell output truncation when just-bash stops before emitting a chunk', async () => {
    const runtime = executionRuntime([{
      name: 'exit',
      code: 126,
      result: DIRECT_SHELL_OUTPUT_TRUNCATED,
    }])

    const result = await executeWorkspaceCommand(
      runtime.workspace,
      'oversized-output',
      '/workspace',
      resolveEdgeCommandTimeoutPolicy(),
    )

    expect(result.outputTruncated).toBe(true)
    expect(result.status).toBe('cancelled')
    expect(result.exitCode).toBe(126)
  })

  it('does not infer terminal causes from command-controlled stderr and exit codes', async () => {
    for (const [exitCode, diagnostic] of [
      [124, 'execution deadline'],
      [126, `limit exceeded (${EDGE_SHELL_OUTPUT_LIMIT_BYTES} bytes)`],
    ] as const) {
      const runtime = executionRuntime([
        { name: 'stderr', value: new TextEncoder().encode(diagnostic) },
        { name: 'exit', code: exitCode },
      ])

      const result = await executeWorkspaceCommand(
        runtime.workspace,
        'forged-diagnostic',
        '/workspace',
        resolveEdgeCommandTimeoutPolicy(),
      )

      expect(result.timedOut).toBe(false)
      expect(result.outputTruncated).toBe(false)
      expect(result.status).toBe('failed')
      expect(result.exitCode).toBe(exitCode)
    }
  })
})

type RuntimeEvent =
  | { name: 'exit'; code: number; result?: unknown }
  | { name: 'stdout' | 'stderr'; value: Uint8Array }

function executionRuntime(
  events: RuntimeEvent[],
  onGetReader?: () => void,
  execDelayMs = 0,
) {
  const stream = new ReadableStream({
    start(controller) {
      for (const [seq, event] of events.entries()) {
        controller.enqueue({ id: 'exec-1', seq, ...event })
      }
      controller.close()
    },
  })
  const kill = vi.fn(async () => undefined)
  const execution = {
    id: 'exec-1',
    backend: 'worker-shell',
    getReader: () => {
      onGetReader?.()
      return stream.getReader()
    },
    kill,
    result: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  }
  const exec = vi.fn(async () => {
    if (execDelayMs > 0) await new Promise(resolve => setTimeout(resolve, execDelayMs))
    return execution
  })
  const mkdir = vi.fn(async () => undefined)
  return {
    exec,
    kill,
    mkdir,
    workspace: { fs: { mkdir }, runtime: { exec } } as unknown as EdgeWorkspace,
  }
}
