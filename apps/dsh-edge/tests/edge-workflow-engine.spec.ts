import { Context, Service } from '@deepseek-ai/cordis'
import type { WorkflowEngine, WorkflowResult, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ RpcTarget: class {} }))

const { default: EdgeWorkflowEngine, WORKFLOW_COMPATIBILITY_DATE, materialize, validateMeta } = await import('../src/edge-workflow-engine.ts')
const {
  MAX_AGENT_REPLY_BYTES,
  MAX_AGENT_REQUEST_BYTES,
  MAX_PROGRESS_CHARS,
  MAX_PROGRESS_IN_FLIGHT,
  MAX_RESULT_BYTES,
  WORKFLOW_BODY_MODULE,
  WORKFLOW_ENTRY_MODULE,
  WORKFLOW_RUNTIME_MODULE,
} = await import('../src/edge-workflow-runtime.ts')

interface FakeChild {
  prompt: string
  label: string | undefined
  signal: AbortSignal
  schema: unknown
  finish(result: { output?: string, structured?: unknown, stopReason?: string }): void
  fail(error: Error): void
  disposed: boolean
}

/** A subagent service whose children settle when a test (or the auto policy) says so. */
class FakeSubagents extends Service {
  children: FakeChild[] = []
  active = 0
  maxActive = 0
  auto: ((child: FakeChild) => void) | undefined = child => {
    child.finish({ output: child.prompt.toUpperCase() })
  }

  constructor(ctx: Context) { super(ctx, 'subagents') }

  getProvider(name: string): object | undefined {
    return name === 'spawn' ? {} : undefined
  }

  /** Called as each child starts, in the caller's async context. */
  onStart: (() => void) | undefined
  /** When set, start() waits for it before publishing the child. */
  startGate: Promise<void> | undefined
  /** When set, a child's dispose() waits for it. */
  disposeGate: Promise<void> | undefined

  async start(_provider: string, request: {
    label?: string
    prompt: { type: 'text', text: string }[]
    signal: AbortSignal
    outputSchema?: unknown
  }) {
    this.onStart?.()
    if (this.startGate !== undefined) await this.startGate
    const settled = Promise.withResolvers<unknown>()
    const index = this.children.length
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    let done = false
    const finishOnce = () => {
      if (done) return false
      done = true
      this.active -= 1
      return true
    }
    const child: FakeChild = {
      prompt: request.prompt[0]!.text,
      label: request.label,
      signal: request.signal,
      schema: request.outputSchema,
      disposed: false,
      finish: ({ output = '', structured, stopReason = 'completed' }) => {
        if (!finishOnce()) return
        settled.resolve({
          output: [{ type: 'text', text: output }],
          ...structured !== undefined ? { structured } : {},
          stopReason,
        })
      },
      fail: error => { if (finishOnce()) settled.reject(error) },
    }
    request.signal.addEventListener('abort', () => { child.finish({ stopReason: 'aborted' }) }, { once: true })
    this.children.push(child)
    queueMicrotask(() => { this.auto?.(child) })
    return {
      id: `child-${index + 1}`,
      localAgent: undefined,
      result: settled.promise,
      dispose: async () => {
        if (this.disposeGate !== undefined) await this.disposeGate
        child.disposed = true
      },
    }
  }
}

interface LoadCall {
  compatibilityDate: string
  mainModule: string
  modules: Record<string, string>
  limits?: { cpuMs?: number }
  globalOutbound?: null
}

interface Bridge {
  agent(prompt: unknown, opts: unknown, phase: unknown): Promise<unknown>
  phase(title: unknown): void
  log(message: unknown): void
}

/**
 * A Worker Loader stand-in: evaluates the generated runtime and body modules in
 * this process, cloning every value that crosses the bridge the way Workers
 * RPC does, and rejects the pending evaluation when the isolate is disposed.
 */
class FakeLoader {
  loads: LoadCall[] = []
  entrypointOptions: unknown[] = []
  bridges: Bridge[] = []
  agentCalls = 0
  disposed = 0
  /** Runs each bridge call the way a real RPC arrives: outside the caller's async context. */
  escape: <T>(fn: () => T) => T = fn => fn()
  /** When set, getEntrypoint() throws it (a worker that fails to initialize). */
  entrypointError: Error | undefined

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
        // Each load gets its own realm, like a Dynamic Worker, so a script that
        // rewrites its builtins cannot reach this test process.
        const context = createContext({})
        const runtime = runInContext(
          `${code.modules[WORKFLOW_RUNTIME_MODULE]!.replace('export async function runWorkflow', 'async function runWorkflow')}\nrunWorkflow`,
          context,
        ) as (host: unknown, input: unknown, workflow: unknown) => Promise<unknown>
        const workflow = runInContext(
          `(${code.modules[WORKFLOW_BODY_MODULE]!.replace('export default async function workflow', 'async function workflow')})`,
          context,
        ) as unknown
        const host = {
          agent: async (...args: unknown[]) => {
            this.agentCalls += 1
            const cloned = structuredClone(args) as [unknown, unknown, unknown]
            return structuredClone(await this.escape(() => bridge.agent(...cloned)))
          },
          phase: async (title: unknown) => { bridge.phase(structuredClone(title)) },
          log: async (message: unknown) => { bridge.log(structuredClone(message)) },
        }
        return Promise.race([
          runtime(host, structuredClone(input), workflow).then(value => structuredClone(value)),
          disposal.promise,
        ])
      },
      [Symbol.dispose]: dispose,
    }
    return {
      getEntrypoint: (_name?: string, options?: unknown) => {
        if (this.entrypointError !== undefined) throw this.entrypointError
        this.entrypointOptions.push(options)
        return entrypoint
      },
      [Symbol.dispose]: dispose,
    }
  }
}

async function setup(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const loader = new FakeLoader()
  await ctx.plugin(FakeSubagents)
  await ctx.plugin(EdgeWorkflowEngine, { loader, ...config } as never)
  const engine = ctx.get('workflowEngine') as WorkflowEngine
  const subagents = ctx.get('subagents') as unknown as FakeSubagents
  const events: unknown[][] = []
  for (const name of ['workflow/start', 'workflow/phase', 'workflow/log',
    'workflow/agent-start', 'workflow/agent-end', 'workflow/end'] as const) {
    ctx.on(name, (...args: unknown[]) => { events.push([name, ...args.slice(1)]) })
  }
  return { engine, subagents, events, loader }
}

function request(script: string, extra: Partial<WorkflowStartRequest> = {}): WorkflowStartRequest {
  return {
    script,
    meta: { name: 'test-flow', description: 'a test workflow' },
    parent: {} as WorkflowStartRequest['parent'],
    ...extra,
  }
}

async function run(engine: WorkflowEngine, script: string, extra: Partial<WorkflowStartRequest> = {}): Promise<WorkflowResult> {
  const handle = engine.start(request(script, extra))
  const result = await handle.result
  await handle.dispose()
  return result
}

describe('edge workflow engine', () => {
  it('runs the script in a Dynamic Worker without network and returns JSON data', async () => {
    const { engine, subagents, events, loader } = await setup()
    const result = await run(engine, `
      phase('Scan')
      log('scanning ' + args.files.length)
      const scanned = await pipeline(args.files, f => agent('scan ' + f), (prev, f) => prev + '!')
      const both = await parallel([() => agent('a', { label: 'first' }), () => agent('b', { phase: 'Other' })])
      return { scanned, both }
    `, { args: { files: ['x', 'y'] } })
    expect(result).toEqual({
      value: { scanned: ['SCAN X!', 'SCAN Y!'], both: ['A', 'B'] },
      stopReason: 'completed',
      agentsStarted: 4,
    })
    expect(loader.loads).toHaveLength(1)
    const load = loader.loads[0]!
    expect(load).toMatchObject({ mainModule: WORKFLOW_ENTRY_MODULE, globalOutbound: null, limits: { cpuMs: 30_000 } })
    expect(Object.keys(load.modules).sort()).toEqual([WORKFLOW_BODY_MODULE, WORKFLOW_ENTRY_MODULE, WORKFLOW_RUNTIME_MODULE].sort())
    expect(load.modules[WORKFLOW_ENTRY_MODULE]).toContain('extends WorkerEntrypoint')
    expect(loader.entrypointOptions[0]).toEqual({ limits: { cpuMs: 30_000 } })
    expect(loader.disposed).toBeGreaterThan(0)
    expect(subagents.children.map(child => child.label)).toEqual(['scan x', 'scan y', 'first', 'b'])
    expect(subagents.children.every(child => child.disposed)).toBe(true)
    const names = events.map(event => event[0])
    expect(names[0]).toBe('workflow/start')
    expect(names.at(-1)).toBe('workflow/end')
    expect(names.filter(name => name === 'workflow/agent-start')).toHaveLength(4)
    expect(names.filter(name => name === 'workflow/agent-end')).toHaveLength(4)
    expect(events).toContainEqual(['workflow/phase', 'Scan'])
    expect(events).toContainEqual(['workflow/log', 'scanning 2'])
    const starts = events.filter(event => event[0] === 'workflow/agent-start').map(event => event[1])
    expect(starts[0]).toMatchObject({ seq: 1, label: 'scan x', phase: 'Scan', childId: 'child-1' })
    expect(starts.find(info => (info as { label: string }).label === 'b')).toMatchObject({ phase: 'Other' })
  })

  it('issues no agent RPC beyond the run cap, even for unawaited calls', async () => {
    const { engine, loader, subagents } = await setup({ maxTotalAgents: 3 })
    const result = await run(engine, `
      const calls = []
      for (let i = 0; i < 1000; i++) calls.push(agent('x' + i).catch(error => error.code))
      return (await Promise.all(calls)).filter(value => value === 'AGENT_CAP').length
    `)
    expect(result).toMatchObject({ stopReason: 'completed', value: 997 })
    expect(loader.agentCalls).toBe(3)
    expect(subagents.children).toHaveLength(3)
  })

  it('bounds the bytes of every bridge path in the isolate', async () => {
    const big = await setup()
    const request = await run(big.engine, `return await agent('x'.repeat(${MAX_AGENT_REQUEST_BYTES}))`)
    expect(request).toMatchObject({ stopReason: 'error' })
    expect(request.error).toContain('agent() request is')
    expect(big.loader.agentCalls).toBe(0)
    const result = await run(big.engine, `return 'z'.repeat(${MAX_RESULT_BYTES} + 1)`)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('the workflow result is')
    const progress = await setup()
    await run(progress.engine, `log('y'.repeat(${MAX_PROGRESS_CHARS} * 3)); phase('p'.repeat(${MAX_PROGRESS_CHARS} * 3)); return 1`)
    const texts = progress.events.filter(event => event[0] === 'workflow/log' || event[0] === 'workflow/phase').map(event => event[1] as string)
    expect(texts.map(text => text.length)).toEqual([MAX_PROGRESS_CHARS + 1, MAX_PROGRESS_CHARS + 1])
  })

  it('measures only a fresh copy, so script hooks cannot smuggle bytes across the bridge', async () => {
    const hooked = await setup()
    const smuggled = await run(hooked.engine, `
      const payload = { huge: 'x'.repeat(${MAX_RESULT_BYTES}) }
      Object.defineProperty(payload, 'toJSON', { value: () => null })
      return payload
    `)
    expect(smuggled.stopReason).toBe('error')
    expect(smuggled.error).toContain('the workflow result is over')
    const replaced = await run(hooked.engine, `
      JSON.stringify = () => '1'
      Object.keys = () => []
      return await agent('x'.repeat(${MAX_AGENT_REQUEST_BYTES}))
    `)
    expect(replaced.stopReason).toBe('error')
    expect(replaced.error).toContain('agent() request is over')
    expect(hooked.loader.agentCalls).toBe(0)
    const getter = await run(hooked.engine, `
      let reads = 0
      const opts = {}
      Object.defineProperty(opts, 'label', { enumerable: true, get: () => (reads += 1) === 1 ? 'small' : 'y'.repeat(1e6) })
      return await agent('p', opts)
    `)
    expect(getter).toMatchObject({ stopReason: 'completed', value: 'P' })
    expect(hooked.subagents.children.at(-1)!.label).toBe('small')
  })

  it('clips agent label and phase before they reach persisted events', async () => {
    const { engine, events, subagents } = await setup()
    await run(engine, `return await agent('p', { label: 'l'.repeat(100000), phase: 'f'.repeat(100000) })`)
    const start = events.find(event => event[0] === 'workflow/agent-start')![1] as { label: string, phase: string }
    expect(start.label.length).toBe(257)
    expect(start.phase.length).toBe(257)
    expect(subagents.children[0]!.label!.length).toBe(257)
  })

  it('caps the child results the host sends back to the isolate', async () => {
    const { engine, subagents } = await setup()
    subagents.auto = child => { child.finish({ output: 'y'.repeat(MAX_AGENT_REPLY_BYTES) }) }
    const result = await run(engine, `return await agent('verbose')`)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('child result is')
  })

  it('re-checks request bytes on the host side of the bridge', async () => {
    const { engine, loader, subagents } = await setup()
    subagents.auto = undefined
    const handle = engine.start(request(`return await agent('hold')`))
    await new Promise(resolve => setTimeout(resolve, 5))
    const reply = await loader.bridges[0]!.agent('x'.repeat(MAX_AGENT_REQUEST_BYTES), null, null)
    expect(reply).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(subagents.children).toHaveLength(1)
    handle.cancel('done')
    await handle.dispose()
  })

  it('bounds progress narration in the isolate and on the host', async () => {
    const burst = await setup()
    await run(burst.engine, `for (let i = 0; i < 10000; i++) log('x'); return 1`)
    expect(burst.events.filter(event => event[0] === 'workflow/log')).toHaveLength(MAX_PROGRESS_IN_FLIGHT)
    const paced = await setup({ maxProgressEvents: 50 })
    await run(paced.engine, `for (let i = 0; i < 200; i++) { log('x' + i); phase('p' + i); await null } return 1`)
    const progress = paced.events.filter(event => event[0] === 'workflow/log' || event[0] === 'workflow/phase')
    expect(progress).toHaveLength(50)
  })

  it('starts children inside the async context of the workflow call', async () => {
    const { engine, loader, subagents } = await setup()
    const turn = new AsyncLocalStorage<string>()
    loader.escape = fn => turn.exit(fn)
    const seen: (string | undefined)[] = []
    subagents.onStart = () => { seen.push(turn.getStore()) }
    const result = await turn.run('turn-1', () => run(engine, `return await parallel([() => agent('a'), () => agent('b')])`))
    expect(result.stopReason).toBe('completed')
    expect(seen).toEqual(['turn-1', 'turn-1'])
  })

  it('exposes only agent, phase, and log on the bridge', async () => {
    const { engine, loader } = await setup()
    await run(engine, 'return 1')
    const bridge = loader.bridges[0]!
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(bridge)).sort()).toEqual(['agent', 'constructor', 'log', 'phase'])
    expect(Object.keys(bridge)).toEqual([])
  })

  it('caps concurrent children on the host', async () => {
    const { engine, subagents } = await setup({ maxConcurrentAgents: 2 })
    const result = await run(engine, `return await parallel([1,2,3,4,5].map(i => () => agent('n' + i)))`)
    expect(result.stopReason).toBe('completed')
    expect(subagents.maxActive).toBe(2)
  })

  it('maps child failure to null and returns structured output for schema calls', async () => {
    const { engine, subagents } = await setup()
    subagents.auto = child => {
      if (child.prompt === 'bad') child.finish({ stopReason: 'error' })
      else child.finish({ output: 'ignored', structured: { ok: true } })
    }
    const result = await run(engine, `
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
      return [await agent('bad'), await agent('good', { schema })]
    `)
    expect(result.value).toEqual([null, { ok: true }])
    expect(subagents.children[1]!.schema).toMatchObject({ type: 'object' })
  })

  it('keeps host-side fatal errors fatal inside combinators', async () => {
    const { engine } = await setup()
    const result = await run(engine, `return await parallel([() => agent('x', { effort: 'high' })])`)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('agent() option "effort" is deferred')
  })

  it('treats arguments the bridge cannot carry as fatal', async () => {
    const { engine } = await setup()
    const result = await run(engine, `return await parallel([() => agent('x', { label: () => 1 })])`)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('function values are not JSON data')
  })

  it('drops an ordinary stage throw to null', async () => {
    const { engine } = await setup()
    const result = await run(engine, `return await pipeline([1, 2], x => { if (x === 1) throw new Error('boom'); return x })`)
    expect(result.value).toEqual([null, 2])
  })

  it('enforces the total agent cap on the host', async () => {
    const { engine } = await setup({ maxTotalAgents: 2 })
    const result = await run(engine, `for (let i = 0; i < 3; i++) await agent('x' + i); return 1`)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('total agent cap (2)')
  })

  it('clips an oversized script error before it becomes the tool result', async () => {
    const { engine } = await setup()
    const result = await run(engine, `throw new Error('e'.repeat(${MAX_PROGRESS_CHARS} * 10))`)
    expect(result.stopReason).toBe('error')
    expect(result.error!.length).toBe(MAX_PROGRESS_CHARS + 1)
  })

  it('reports a script error as the run error', async () => {
    const { engine } = await setup()
    const result = await run(engine, `throw new Error('script broke')`)
    expect(result).toMatchObject({ stopReason: 'error', error: 'script broke' })
  })

  it('cancels by terminating the isolate and pairs every agent-start with an end', async () => {
    const { engine, subagents, events, loader } = await setup()
    subagents.auto = undefined
    const controller = new AbortController()
    const handle = engine.start(request(`return await parallel([() => agent('a'), () => agent('b')])`, {
      signal: controller.signal,
    }))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(subagents.children).toHaveLength(2)
    controller.abort()
    const result = await handle.result
    await handle.dispose()
    expect(result.stopReason).toBe('cancelled')
    expect(loader.disposed).toBeGreaterThan(0)
    expect(subagents.children.every(child => child.signal.aborted && child.disposed)).toBe(true)
    const ends = events.filter(event => event[0] === 'workflow/agent-end')
    expect(ends).toHaveLength(2)
    expect(ends.every(event => (event[1] as { outcome: string }).outcome === 'cancelled')).toBe(true)
  })

  it('waits for a child whose start was pending at disposal', async () => {
    const { engine, subagents } = await setup({ disposeGraceMs: 1_000 })
    subagents.auto = undefined
    const start = Promise.withResolvers<void>()
    const cleanup = Promise.withResolvers<void>()
    subagents.startGate = start.promise
    subagents.disposeGate = cleanup.promise
    const handle = engine.start(request(`return await agent('slow start')`))
    await new Promise(resolve => setTimeout(resolve, 5))
    let disposed = false
    const disposal = handle.dispose().then(() => { disposed = true })
    // The race window: the run has settled and disposal waits only on the pending start.
    await expect(handle.result).resolves.toMatchObject({ stopReason: 'cancelled' })
    start.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(subagents.children).toHaveLength(1)
    expect(disposed).toBe(false)
    cleanup.resolve()
    await disposal
    expect(subagents.children[0]!.disposed).toBe(true)
  })

  it('settles a script parked on a promise no hook owns once it is cancelled', async () => {
    const { engine } = await setup({ disposeGraceMs: 10 })
    const handle = engine.start(request(`await new Promise(() => {}); return 1`))
    await new Promise(resolve => setTimeout(resolve, 5))
    handle.cancel('test')
    await expect(handle.result).resolves.toMatchObject({ stopReason: 'cancelled', error: 'workflow run cancelled: test' })
    await handle.dispose()
  })

  it('disposes the worker when its entrypoint cannot be created', async () => {
    const { engine, loader } = await setup()
    loader.entrypointError = new Error('worker failed to initialize')
    const result = await run(engine, 'return 1')
    expect(result).toMatchObject({ stopReason: 'error', error: 'worker failed to initialize' })
    expect(loader.loads).toHaveLength(1)
    expect(loader.disposed).toBe(1)
  })

  it('does not load an isolate when the start signal is already aborted', async () => {
    const { engine, loader } = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await run(engine, `await agent('never'); return 1`, { signal: controller.signal })
    expect(result.stopReason).toBe('cancelled')
    expect(loader.loads).toHaveLength(0)
  })

  it('rejects non-JSON return values', async () => {
    const { engine } = await setup()
    const result = await run(engine, `return { when: new Date(0) }`)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('only plain objects and arrays are JSON data')
  })

  it('throws synchronously for bad meta, bad syntax, wrapper escapes, and unknown providers', async () => {
    const { engine, loader } = await setup()
    expect(() => engine.start({ ...request('return 1'), meta: { name: '' } as never }))
      .toThrow(expect.objectContaining({ code: 'META_INVALID' }) as Error)
    expect(() => engine.start(request('return (')))
      .toThrow(expect.objectContaining({ code: 'SCRIPT_PARSE' }) as Error)
    expect(() => engine.start(request('export const meta = {}\nreturn 1')))
      .toThrow(/meta rides the `meta` request field/u)
    expect(() => engine.start(request('}\nexport const escaped = 1\nfunction rest() {')))
      .toThrow(/must not close its wrapper/u)
    expect(() => engine.start(request('return 1', { subagentProvider: 'missing' })))
      .toThrow(expect.objectContaining({ code: 'AGENT_START' }) as Error)
    expect(loader.loads).toHaveLength(0)
  })
})

describe('workflow isolate configuration', () => {
  it('runs the isolate with the deployment compatibility date', async () => {
    const { readFile } = await import('node:fs/promises')
    const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    expect(wrangler).toContain(`"compatibility_date": "${WORKFLOW_COMPATIBILITY_DATE}"`)
  })
})

describe('workflow value helpers', () => {
  it('normalizes meta and names every violation', () => {
    expect(validateMeta({ name: 'n', description: 'd', phases: [{ title: 'A', detail: 'x' }] }))
      .toEqual({ name: 'n', description: 'd', phases: [{ title: 'A', detail: 'x' }] })
    expect(() => validateMeta({ name: 'n', description: 'd', extra: 1, phases: [{ bad: 1 }] }))
      .toThrow(/meta\.extra is not a recognized field.*meta\.phases\[0\]\.bad.*title must be a non-empty string/u)
  })

  it('materializes plain JSON and rejects cycles, sparse arrays, and class instances', () => {
    expect(materialize({ a: [1, 'x', null, { b: true }] }, 'v')).toEqual({ a: [1, 'x', null, { b: true }] })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => materialize(cycle, 'v')).toThrow(/circular/u)
    // eslint-disable-next-line no-sparse-arrays
    expect(() => materialize([1, , 3], 'v')).toThrow(/sparse/u)
    expect(() => materialize(new Map(), 'v')).toThrow(/exotic prototype/u)
    expect(() => materialize({ n: Number.NaN }, 'v')).toThrow(/non-finite/u)
  })
})
