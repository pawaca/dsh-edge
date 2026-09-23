import { Context, Service } from '@deepseek-ai/cordis'
import type { WorkflowEngine, WorkflowResult, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { WorkflowError } from '@deepseek-ai/dsh-workflow'
import { describe, expect, it } from 'vitest'
import EdgeWorkflowEngine, { materialize, validateMeta } from '../src/edge-workflow-engine.ts'
import { compileWorkflowScript } from '../src/edge-workflow-script.ts'

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

  async start(_provider: string, request: {
    label?: string
    prompt: { type: 'text', text: string }[]
    signal: AbortSignal
    outputSchema?: unknown
  }) {
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
      dispose: async () => { child.disposed = true },
    }
  }
}

async function setup(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(FakeSubagents)
  await ctx.plugin(EdgeWorkflowEngine, config as never)
  const engine = ctx.get('workflowEngine') as WorkflowEngine
  const subagents = ctx.get('subagents') as unknown as FakeSubagents
  const events: unknown[][] = []
  for (const name of ['workflow/start', 'workflow/phase', 'workflow/log',
    'workflow/agent-start', 'workflow/agent-end', 'workflow/end'] as const) {
    ctx.on(name, (...args: unknown[]) => { events.push([name, ...args.slice(1)]) })
  }
  return { engine, subagents, events }
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
  it('runs agents through pipeline and parallel and returns JSON data', async () => {
    const { engine, subagents, events } = await setup()
    const result = await run(engine, `
      phase('Scan')
      log('scanning ' + args.files.length)
      const scanned = await pipeline(args.files, f => agent('scan ' + f), (prev, f) => prev + '!')
      const both = await parallel([() => agent('a', { label: 'first' }), () => agent('b')])
      return { scanned, both }
    `, { args: { files: ['x', 'y'] } })
    expect(result).toEqual({
      value: { scanned: ['SCAN X!', 'SCAN Y!'], both: ['A', 'B'] },
      stopReason: 'completed',
      agentsStarted: 4,
    })
    expect(subagents.children.map(child => child.label)).toEqual(['scan x', 'scan y', 'first', 'b'])
    expect(subagents.children.every(child => child.disposed)).toBe(true)
    const names = events.map(event => event[0])
    expect(names[0]).toBe('workflow/start')
    expect(names.at(-1)).toBe('workflow/end')
    expect(names.filter(name => name === 'workflow/agent-start')).toHaveLength(4)
    expect(names.filter(name => name === 'workflow/agent-end')).toHaveLength(4)
    expect(events).toContainEqual(['workflow/phase', 'Scan'])
    expect(events).toContainEqual(['workflow/log', 'scanning 2'])
    const firstStart = events.find(event => event[0] === 'workflow/agent-start')
    expect(firstStart?.[1]).toMatchObject({ seq: 1, label: 'scan x', phase: 'Scan', childId: 'child-1' })
  })

  it('caps concurrent children', async () => {
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

  it('keeps fatal hook errors fatal inside combinators', async () => {
    const { engine } = await setup()
    const result = await run(engine, `return await parallel([() => agent('x', { effort: 'high' })])`)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('agent() option "effort" is deferred')
  })

  it('drops an ordinary stage throw to null', async () => {
    const { engine } = await setup()
    const result = await run(engine, `return await pipeline([1, 2], x => { if (x === 1) throw new Error('boom'); return x })`)
    expect(result.value).toEqual([null, 2])
  })

  it('stops a synchronous hot loop with the step budget, even when caught', async () => {
    const { engine } = await setup({ maxSteps: 1000 })
    const result = await run(engine, `
      try { while (true) {} } catch (e) {}
      return 'escaped'
    `)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('step budget')
  })

  it('stops runaway recursion with the step budget', async () => {
    const { engine } = await setup({ maxSteps: 1000 })
    const result = await run(engine, `const f = n => f(n + 1); return f(0)`)
    expect(result.stopReason).toBe('error')
  })

  it('enforces the total agent cap', async () => {
    const { engine } = await setup({ maxTotalAgents: 2 })
    const result = await run(engine, `for (let i = 0; i < 3; i++) await agent('x' + i); return 1`)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('total agent cap (2)')
  })

  it('cancels running children and pairs every agent-start with an end', async () => {
    const { engine, subagents, events } = await setup()
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
    expect(subagents.children.every(child => child.signal.aborted && child.disposed)).toBe(true)
    const ends = events.filter(event => event[0] === 'workflow/agent-end')
    expect(ends).toHaveLength(2)
    expect(ends.every(event => (event[1] as { outcome: string }).outcome === 'cancelled')).toBe(true)
  })

  it('force-settles a script parked on a promise no hook owns', async () => {
    const { engine } = await setup({ disposeGraceMs: 10 })
    const handle = engine.start(request(`await new Promise(() => {}); return 1`))
    await new Promise(resolve => setTimeout(resolve, 5))
    handle.cancel('test')
    const result = await handle.result
    expect(result).toMatchObject({ stopReason: 'cancelled', error: 'workflow run cancelled: test' })
    await handle.dispose()
  })

  it('does not run the body when the start signal is already aborted', async () => {
    const { engine, subagents } = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await run(engine, `await agent('never'); return 1`, { signal: controller.signal })
    expect(result.stopReason).toBe('cancelled')
    expect(subagents.children).toHaveLength(0)
  })

  it('rejects non-JSON return values', async () => {
    const { engine } = await setup()
    const result = await run(engine, `return { when: new Date(0) }`)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('not plain JSON data')
  })

  it('throws synchronously for bad meta, bad syntax, and unknown providers', async () => {
    const { engine } = await setup()
    expect(() => engine.start({ ...request('return 1'), meta: { name: '' } as never }))
      .toThrow(expect.objectContaining({ code: 'META_INVALID' }) as Error)
    expect(() => engine.start(request('return (')))
      .toThrow(expect.objectContaining({ code: 'SCRIPT_PARSE' }) as Error)
    expect(() => engine.start(request('export const meta = {}\nreturn 1')))
      .toThrow(/meta rides the `meta` request field/u)
    expect(() => engine.start(request('return 1', { subagentProvider: 'missing' })))
      .toThrow(expect.objectContaining({ code: 'AGENT_START' }) as Error)
  })
})

describe('workflow script sandbox', () => {
  async function evaluate(body: string): Promise<unknown> {
    const program = compileWorkflowScript(body, 'probe')
    const noop = () => undefined
    return program.run({ agent: noop, parallel: noop, pipeline: noop, phase: noop, log: noop, args: undefined, tick: noop })
  }

  it('exposes only ECMAScript data builtins', async () => {
    await expect(evaluate(`return [typeof fetch, typeof setTimeout, typeof globalThis.fetch,
      typeof process, typeof console, typeof Function, typeof eval, typeof globalThis.globalThis]`))
      .resolves.toEqual(Array(8).fill('undefined'))
    await expect(evaluate(`return [typeof Array, typeof JSON, typeof Promise, typeof Map]`))
      .resolves.toEqual(['function', 'object', 'function', 'function'])
    expect(typeof globalThis.fetch).toBe('function')
  })

  it('refuses prototype access and reserved identifiers', () => {
    expect(() => compileWorkflowScript('Array.prototype.map = null', 'probe')).toThrow(/"prototype"/u)
    expect(() => compileWorkflowScript('({}).__proto__.x = 1', 'probe')).toThrow(/"__proto__"/u)
    expect(() => compileWorkflowScript(`({})['prototype']`, 'probe')).toThrow(/"prototype"/u)
    expect(() => compileWorkflowScript('__dshSettle(Promise.resolve(1))', 'probe')).toThrow(/reserved/u)
  })

  it('reports parse errors as SCRIPT_PARSE', () => {
    try {
      compileWorkflowScript('let = ;', 'probe')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError)
      expect((error as WorkflowError).code).toBe('SCRIPT_PARSE')
    }
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
