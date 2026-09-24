import { Context } from '@deepseek-ai/cordis'
import type { CodeBindingNamespace, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ RpcTarget: class {} }))

const { default: EdgeCodeRuntime } = await import('../src/edge-code-runtime.ts')
const {
  CODE_ENTRY_MODULE,
  CODE_PROGRAM_MODULE,
  CODE_RUNTIME_MODULE,
  MAX_LOGS_IN_FLIGHT,
} = await import('../src/edge-code-runtime-isolate.ts')

interface LoadCall {
  compatibilityDate: string
  mainModule: string
  modules: Record<string, string>
  limits?: { cpuMs?: number }
  globalOutbound?: null
}

interface Bridge {
  call(global: unknown, name: unknown, args: unknown): Promise<unknown>
  log(text: unknown): void
}

/**
 * A Worker Loader stand-in: each load evaluates the generated runtime and
 * program modules in its own `node:vm` realm, clones everything that crosses
 * the bridge the way Workers RPC does, and rejects the pending evaluation when
 * the isolate is disposed.
 */
class FakeLoader {
  loads: LoadCall[] = []
  bridges: Bridge[] = []
  calls = 0
  disposed = 0
  entrypointError: Error | undefined
  /** Runs each bridge call the way a real RPC arrives: outside the caller's async context. */
  escape: <T>(fn: () => T) => T = fn => fn()
  /** Delay before a log RPC reaches the host, like a real cross-isolate call. */
  logDelayMs = 0

  load(code: LoadCall) {
    this.loads.push(code)
    const disposal = Promise.withResolvers<never>()
    disposal.promise.catch(() => {})
    const dispose = () => {
      this.disposed += 1
      disposal.reject(new Error('isolate disposed'))
    }
    const entrypoint = {
      evaluate: async (bridge: Bridge, input: unknown) => {
        this.bridges.push(bridge)
        const context = createContext({})
        const runtime = runInContext(
          `${code.modules[CODE_RUNTIME_MODULE]!.replace('export async function runProgram', 'async function runProgram')}\nrunProgram`,
          context,
        ) as (host: unknown, input: unknown, program: unknown) => Promise<unknown>
        const program = runInContext(
          `(${code.modules[CODE_PROGRAM_MODULE]!.replace('export default async function program', 'async function program')})`,
          context,
        ) as unknown
        const host = {
          call: async (...args: unknown[]) => {
            this.calls += 1
            const cloned = structuredClone(args) as [unknown, unknown, unknown]
            return structuredClone(await this.escape(() => bridge.call(...cloned)))
          },
          log: async (text: unknown) => {
            if (this.logDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.logDelayMs))
            bridge.log(structuredClone(text))
          },
        }
        return Promise.race([
          runtime(host, structuredClone(input), program).then(value => structuredClone(value)),
          disposal.promise,
        ])
      },
      [Symbol.dispose]: dispose,
    }
    return {
      getEntrypoint: () => {
        if (this.entrypointError !== undefined) throw this.entrypointError
        return entrypoint
      },
      [Symbol.dispose]: dispose,
    }
  }
}

async function setup(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const loader = new FakeLoader()
  await ctx.plugin(EdgeCodeRuntime, { loader, ...config } as never)
  const runtime = ctx.get('codeRuntime') as InstanceType<typeof EdgeCodeRuntime>
  return { ctx, runtime, loader }
}

function tools(functions: CodeBindingNamespace['functions']): CodeBindingNamespace {
  return { global: 'tools', functions, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }
}

const echo = tools({
  read: async args => ({ echoed: args as never }),
  fail: async () => { throw new Error('tool refused') },
  // Computed key: a literal `__proto__:` would set the prototype instead.
  ['__proto__']: async () => 'proto member',
  constructor: async () => 'constructor member',
})

describe('edge code runtime', () => {
  it('runs a TypeScript program in a Dynamic Worker against the tools binding', async () => {
    const { runtime, loader } = await setup()
    const result = await runtime.run({
      program: `
        interface Row { n: number }
        const rows: Row[] = [{ n: 1 }, { n: 2 }]
        console.log('rows', rows.length)
        const first = await tools.read({ path: 'a.txt' })
        return { first, total: rows.reduce((sum: number, row: Row) => sum + row.n, 0) }
      `,
      bindings: [echo],
    })
    expect(result).toEqual({ logs: ['rows 2'], value: { first: { echoed: { path: 'a.txt' } }, total: 3 } })
    expect(runtime.language).toBe('typescript')
    expect(runtime.isolation).toBe('dynamic-worker')
    const load = loader.loads[0]!
    expect(load).toMatchObject({ mainModule: CODE_ENTRY_MODULE, globalOutbound: null, limits: { cpuMs: 30_000 } })
    expect(load.modules[CODE_PROGRAM_MODULE]).toContain('export default async function program(tools, ToolCallError, console)')
    expect(loader.disposed).toBeGreaterThan(0)
    const bridge = loader.bridges[0]!
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(bridge)).sort()).toEqual(['call', 'constructor', 'log'])
  })

  it('runs binding calls inside the async context of the run_code call', async () => {
    const { runtime, loader } = await setup()
    const turn = new AsyncLocalStorage<string>()
    loader.escape = fn => turn.exit(fn)
    const seen: (string | undefined)[] = []
    const result = await turn.run('turn-1', () => runtime.run({
      program: `return await tools.where({})`,
      bindings: [tools({ where: async () => { seen.push(turn.getStore()); return turn.getStore() ?? null } })],
    }))
    expect(result.value).toBe('turn-1')
    expect(seen).toEqual(['turn-1'])
  })

  it('rejects failed binding calls with the namespace error class', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: `
        try {
          await tools.fail({})
        } catch (error) {
          return [error instanceof ToolCallError, error.name, error.toolName, error.message]
        }
      `,
      bindings: [echo],
    })
    expect(result.value).toEqual([true, 'ToolCallError', 'fail', 'tool refused'])
  })

  it('treats __proto__ and constructor as ordinary binding names', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: `return [await tools['__proto__']({}), await tools['constructor']({}), Object.getPrototypeOf(tools)]`,
      bindings: [echo],
    })
    expect(result.value).toEqual(['proto member', 'constructor member', null])
  })

  it('refuses unknown members and oversized or lossy arguments on the host', async () => {
    const { runtime, loader } = await setup({ maxBindingArgBytes: 64 })
    const held = Promise.withResolvers<void>()
    const pending = runtime.run({ program: `await tools.hold({}); return 1`, bindings: [tools({ hold: async () => { await held.promise; return null } })] })
    await new Promise(resolve => setTimeout(resolve, 5))
    const bridge = loader.bridges[0]!
    await expect(bridge.call('tools', 'missing', {})).resolves.toMatchObject({ ok: false, message: 'unknown binding "tools.missing"' })
    await expect(bridge.call('tools', 'hold', { big: 'x'.repeat(100) })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('over the 64-byte limit') as string })
    await expect(bridge.call('tools', 'hold', { bad: Number.NaN })).resolves.toMatchObject({ ok: false, message: 'binding arguments must be lossless JSON' })
    held.resolve()
    await expect(pending).resolves.toMatchObject({ value: 1 })
  })

  it('caps binding calls in the isolate and on the host', async () => {
    const { runtime, loader } = await setup({ maxBindingCalls: 3 })
    let invoked = 0
    const result = await runtime.run({
      program: `
        const settled = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => tools.count({ i })))
        return settled.filter(outcome => outcome.status === 'rejected').length
      `,
      bindings: [tools({ count: async () => { invoked += 1; return invoked } })],
    })
    expect(result.value).toBe(7)
    expect(invoked).toBe(3)
    expect(loader.calls).toBe(3)
  })

  it('caps binding replies and rejects lossy resolutions', async () => {
    const { runtime } = await setup({ maxBindingReplyBytes: 64 })
    const result = await runtime.run({
      program: `
        const out = []
        for (const name of ['big', 'lossy']) {
          try { await tools[name]({}) } catch (error) { out.push(error.message) }
        }
        return out
      `,
      bindings: [tools({ big: async () => 'y'.repeat(200), lossy: async () => ({ when: new Date(0) }) as never })],
    })
    expect(result.value).toEqual([
      expect.stringContaining('over the 64-byte limit'),
      'binding resolution must be lossless JSON',
    ])
  })

  it('classifies program failures', async () => {
    const roomy = await setup()
    await expect(roomy.runtime.run({ program: `throw new Error('boom')`, bindings: [] }))
      .resolves.toMatchObject({ error: { kind: 'exception', message: expect.stringContaining('boom') as string } })
    const { runtime } = await setup({ maxOutputBytes: 256 })
    await expect(runtime.run({ program: `return new Date(0)`, bindings: [] }))
      .resolves.toMatchObject({ error: { kind: 'invalid-output' } })
    await expect(runtime.run({ program: `return 'z'.repeat(1000)`, bindings: [] }))
      .resolves.toMatchObject({ error: { kind: 'output-limit' } })
    const empty: CodeRunResult = await runtime.run({ program: `const x = 1`, bindings: [] })
    expect(empty).toEqual({ logs: [] })
  })

  it('measures completion bytes the way JSON encodes them', async () => {
    const { runtime } = await setup({ maxOutputBytes: 4096 })
    // Raw length 1000 fits; JSON escaping (\\u0000 is 6 bytes each) does not.
    await expect(runtime.run({ program: `return '\\u0000'.repeat(1000)`, bindings: [] }))
      .resolves.toMatchObject({ error: { kind: 'output-limit', message: 'program completion exceeded 4096 bytes' } })
    const escaped = await runtime.run({ program: `return 'quote " backslash \\\\ lone \\ud800 pair 😀'`, bindings: [] })
    expect(escaped.value).toBe('quote " backslash \\ lone \ud800 pair 😀')
  })

  it('reports type-strip and wrapper failures as exceptions without loading an isolate', async () => {
    const { runtime, loader } = await setup()
    await expect(runtime.run({ program: `return (`, bindings: [] }))
      .resolves.toMatchObject({ error: { kind: 'exception' } })
    await expect(runtime.run({ program: `}\nexport const escaped = 1\nfunction rest() {`, bindings: [] }))
      .resolves.toMatchObject({ error: { kind: 'exception' } })
    expect(loader.loads).toHaveLength(0)
    const enumRun = await runtime.run({ program: `enum Color { Red, Green }\nreturn Color.Green`, bindings: [] })
    expect(enumRun.value).toBe(1)
  })

  it('bounds console output with the outer-output ledger', async () => {
    const { runtime } = await setup({ maxOutputBytes: 100 })
    const result = await runtime.run({
      program: `for (let i = 0; i < 20; i++) { console.log('line ' + i); await null }\nreturn 1`,
      bindings: [],
    })
    expect(result.error).toMatchObject({ kind: 'output-limit' })
    expect(result.logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(result).length).toBeLessThan(200)
  })

  it('delivers logs sent just before the program returns', async () => {
    const { runtime, loader } = await setup()
    loader.logDelayMs = 10
    const result = await runtime.run({ program: `console.log('first'); console.warn('last'); return 1`, bindings: [] })
    expect(result).toEqual({ logs: ['first', 'last'], value: 1 })
  })

  it('keeps at most a fixed number of log RPCs in flight', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({ program: `for (let i = 0; i < 1000; i++) console.log('x'); return 1`, bindings: [] })
    expect(result.logs).toHaveLength(MAX_LOGS_IN_FLIGHT)
  })

  it('times out, aborts, and disposes the isolate', async () => {
    const wall = await setup({ maxWallMs: 20 })
    await expect(wall.runtime.run({ program: `await new Promise(() => {})`, bindings: [] }))
      .resolves.toMatchObject({ error: { kind: 'timeout' } })
    expect(wall.loader.disposed).toBeGreaterThan(0)
    const controller = new AbortController()
    const running = wall.runtime.run({ program: `await new Promise(() => {})`, bindings: [], signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort('stop')
    await expect(running).resolves.toMatchObject({ error: { kind: 'abort', message: 'stop' } })
    const aborted = new AbortController()
    aborted.abort('early')
    const loads = wall.loader.loads.length
    await expect(wall.runtime.run({ program: `return 1`, bindings: [], signal: aborted.signal }))
      .resolves.toMatchObject({ error: { kind: 'abort' } })
    expect(wall.loader.loads).toHaveLength(loads)
  })

  it('reports an isolate that fails to start as worker-exit and disposes it', async () => {
    const { runtime, loader } = await setup()
    loader.entrypointError = new Error('worker failed to initialize')
    await expect(runtime.run({ program: `return 1`, bindings: [] }))
      .resolves.toMatchObject({ error: { kind: 'worker-exit' } })
    expect(loader.disposed).toBe(1)
  })

  it('settles live runs on disposal and refuses runs afterwards', async () => {
    const { ctx, runtime } = await setup()
    const running = runtime.run({ program: `await new Promise(() => {})`, bindings: [] })
    await new Promise(resolve => setTimeout(resolve, 5))
    await ctx.fiber.dispose()
    await expect(running).resolves.toMatchObject({ error: { kind: 'abort', message: 'runtime disposed' } })
    await expect(runtime.run({ program: `return 1`, bindings: [] })).rejects.toThrow(/after disposal/u)
  })

  it('rejects invalid binding namespaces as seam misuse', async () => {
    const { runtime } = await setup()
    const invalid: CodeBindingNamespace[][] = [
      [{ global: 'console', functions: {} }],
      [{ global: '$tools', functions: {} }],
      [{ global: 'class', functions: {} }],
      [{ global: 'tools', functions: {} }, { global: 'tools', functions: {} }],
      [{ global: 'tools', functions: {}, errorClass: { name: 'E', memberNameProperty: 'message' } }],
      [{ global: 'tools', functions: {}, errorClass: { name: 'tools', memberNameProperty: 'toolName' } }],
    ]
    for (const bindings of invalid) {
      await expect(runtime.run({ program: 'return 1', bindings }), JSON.stringify(bindings)).rejects.toThrow(/edge code-runtime/u)
    }
  })
})
