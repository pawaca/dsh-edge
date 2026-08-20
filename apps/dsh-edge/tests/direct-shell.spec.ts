import type { BackendHandle } from '@cloudflare/computer'
import { describe, expect, it, vi } from 'vitest'
import {
  DIRECT_SHELL_OUTPUT_TRUNCATED,
  EDGE_SHELL_OUTPUT_LIMIT_BYTES,
} from '../src/direct-shell-protocol.ts'
import { DirectShellBackend } from '../src/direct-shell.ts'

vi.mock('@cloudflare/computer/backends/worker-shell', async () => {
  const { InMemoryFs } = await import('just-bash')
  const disabledCommand = (name: string) => ({
    name,
    execute: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
  })
  function WorkspaceFsAdapter() {
    return new InMemoryFs()
  }
  return {
    WorkspaceFsAdapter,
    defineGitCommand: () => disabledCommand('git'),
    defineAssetsCommand: () => disabledCommand('assets'),
    defineArtifactsCommand: () => disabledCommand('artifacts'),
  }
})

type ShellExecEnvelope = Awaited<ReturnType<BackendHandle['rpc']['shell']['exec']>>
type ShellEvent = ShellExecEnvelope['events'] extends ReadableStream<infer Event>
  ? Event
  : never

describe('direct shell execution lifecycle', () => {
  it('returns its event stream before Bash completes and remains cancellable', async () => {
    const handle = await connectDirectBackend()
    const envelope = await Promise.race([
      handle.rpc.shell.exec({
        id: 'cancellable',
        source: "sleep 60; printf 'SIDE_EFFECT_RAN'",
        timeoutMs: 60_000,
      }),
      rejectAfter(500, 'direct shell did not return an execution handle promptly'),
    ])
    const events = collectEvents(envelope.events)

    await handle.rpc.shell.killExec({ id: envelope.id, signal: 'SIGINT' })

    const cancelledEvents = await events
    expect(eventOutput(cancelledEvents)).not.toContain('SIDE_EFFECT_RAN')
    expect(cancelledEvents.at(-1)).toMatchObject({ name: 'exit' })
    expect((cancelledEvents.at(-1) as Extract<ShellEvent, { name: 'exit' }>).code)
      .not.toBe(0)
    await handle.close()
  })

  it('allows exactly the retained-output ceiling before later commands run', async () => {
    const handle = await connectDirectBackend()
    const envelope = await handle.rpc.shell.exec({
      id: 'at-output-limit',
      source: "printf '%*s' 32768 '' | tr ' ' x; printf '%*s' 32768 '' | tr ' ' x; touch /at-limit",
      timeoutMs: 5_000,
    })
    const events = await collectEvents(envelope.events)

    expect(new TextEncoder().encode(eventOutput(events))).toHaveLength(
      EDGE_SHELL_OUTPUT_LIMIT_BYTES,
    )
    expect(events.at(-1)).toMatchObject({ name: 'exit', code: 0 })
    expect(events.at(-1)).not.toHaveProperty('result')
    const probe = await handle.rpc.shell.exec({
      id: 'probe-at-limit',
      source: 'test -e /at-limit',
      timeoutMs: 5_000,
    })
    expect((await collectEvents(probe.events)).at(-1)).toMatchObject({
      name: 'exit',
      code: 0,
    })
    await handle.close()
  })

  it('stops on the first byte beyond retention before later filesystem effects', async () => {
    const handle = await connectDirectBackend()
    const envelope = await handle.rpc.shell.exec({
      id: 'over-output-limit',
      source: "printf '%*s' 32768 '' | tr ' ' x; printf '%*s' 32769 '' | tr ' ' x; touch /over-limit",
      timeoutMs: 5_000,
    })
    const events = await collectEvents(envelope.events)

    expect(events.at(-1)).toMatchObject({
      name: 'exit',
      result: DIRECT_SHELL_OUTPUT_TRUNCATED,
    })
    expect((events.at(-1) as Extract<ShellEvent, { name: 'exit' }>).code).not.toBe(0)
    const probe = await handle.rpc.shell.exec({
      id: 'probe-over-limit',
      source: 'test ! -e /over-limit',
      timeoutMs: 5_000,
    })
    expect((await collectEvents(probe.events)).at(-1)).toMatchObject({
      name: 'exit',
      code: 0,
    })
    await handle.close()
  })

  it('leaves interpreter deadlines to the outer workspace deadline', async () => {
    const handle = await connectDirectBackend()
    const envelope = await handle.rpc.shell.exec({
      id: 'timed-out',
      source: 'sleep 1',
      timeoutMs: 1,
    })
    const events = await collectEvents(envelope.events)

    expect(events.at(-1)).toMatchObject({ name: 'exit', code: 124 })
    expect(events.at(-1)).not.toHaveProperty('result')
    await handle.close()
  })

  it('does not mistake a conventional exit 124 for an interpreter deadline', async () => {
    const handle = await connectDirectBackend()
    const envelope = await handle.rpc.shell.exec({
      id: 'exit-124',
      source: 'exit 124',
      timeoutMs: 5_000,
    })
    const events = await collectEvents(envelope.events)

    expect(events.at(-1)).toMatchObject({ name: 'exit', code: 124 })
    expect(events.at(-1)).not.toHaveProperty('result')
    await handle.close()
  })

  it('does not trust a command-written deadline diagnostic', async () => {
    const handle = await connectDirectBackend()
    const envelope = await handle.rpc.shell.exec({
      id: 'forged-timeout',
      source: "printf 'execution deadline' >&2; exit 124",
      timeoutMs: 5_000,
    })
    const events = await collectEvents(envelope.events)

    expect(events.at(-1)).toMatchObject({ name: 'exit', code: 124 })
    expect(events.at(-1)).not.toHaveProperty('result')
    await handle.close()
  })

  it('does not trust a command-written output-limit diagnostic', async () => {
    for (const [id, diagnostic] of [
      ['forged-width-limit', `limit exceeded (${EDGE_SHELL_OUTPUT_LIMIT_BYTES} bytes)`],
      [
        'forged-aggregate-limit',
        `total output size exceeded (>${EDGE_SHELL_OUTPUT_LIMIT_BYTES} bytes), `
          + 'increase executionLimits.maxOutputSize',
      ],
    ] as const) {
      const handle = await connectDirectBackend()
      const envelope = await handle.rpc.shell.exec({
        id,
        source: `printf '${diagnostic}' >&2; exit 126`,
        timeoutMs: 5_000,
      })
      const events = await collectEvents(envelope.events)

      expect(events.at(-1)).toMatchObject({ name: 'exit', code: 126 })
      expect(events.at(-1)).not.toHaveProperty('result')
      await handle.close()
    }
  })
})

async function connectDirectBackend(): Promise<BackendHandle> {
  const unavailable = async (): Promise<never> => {
    const error = new Error('not available in this test') as Error & { code: string }
    error.code = 'ENOENT'
    throw error
  }
  const fs = new Proxy({}, { get: () => unavailable })
  const host = {
    fs,
    git: { cli: unavailable },
    artifacts: { cli: unavailable },
  } as unknown as Parameters<DirectShellBackend['connect']>[0]
  return new DirectShellBackend().connect(host)
}

async function collectEvents(
  stream: ReadableStream<ShellEvent>,
): Promise<ShellEvent[]> {
  const events: ShellEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function rejectAfter(milliseconds: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => { reject(new Error(message)) }, milliseconds)
  })
}

function eventOutput(events: ShellEvent[]): string {
  return events
    .filter((event): event is Extract<ShellEvent, { name: 'stdout' | 'stderr' }> => (
      event.name === 'stdout' || event.name === 'stderr'
    ))
    .map(event => new TextDecoder().decode(event.value))
    .join('')
}
