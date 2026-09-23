/**
 * Source of the modules a workflow run loads into its own Dynamic Worker.
 *
 * The isolate holds only the script and these hooks. Everything that protects
 * the Durable Object (argument validation, agent caps, concurrency, child
 * lifecycle, events) runs on the host behind the bridge the entrypoint
 * receives, so a script that tampers with this runtime only affects its own
 * isolate. Every bridge method is also bounded here, so the isolate can
 * never queue more RPCs than the host would accept: `agent()` counts
 * accepted calls against the run's agent cap, and `phase()`/`log()` keep a
 * fixed number in flight. The hook semantics mirror the published worker-thread engine:
 * fatal `WorkflowError`s propagate through `parallel()` and `pipeline()`,
 * while ordinary failures become per-item `null`.
 */

/** Module names inside the workflow isolate. */
export const WORKFLOW_ENTRY_MODULE = 'workflow-entry.js'
export const WORKFLOW_RUNTIME_MODULE = 'workflow-runtime.js'
export const WORKFLOW_BODY_MODULE = 'workflow-body.js'

/** Progress RPCs (`phase`/`log`) the isolate keeps in flight at once; extra calls are dropped. */
export const MAX_PROGRESS_IN_FLIGHT = 64

/** Main module: a WorkerEntrypoint whose `evaluate` runs the script against the host bridge. */
export const WORKFLOW_ENTRY_SOURCE = `import { WorkerEntrypoint } from 'cloudflare:workers'
import { runWorkflow } from '${WORKFLOW_RUNTIME_MODULE}'
import workflow from '${WORKFLOW_BODY_MODULE}'

export default class extends WorkerEntrypoint {
  evaluate(host, input) {
    return runWorkflow(host, input, workflow)
  }
}
`

/**
 * Hook implementations. Plain JavaScript (no platform imports) so unit tests
 * can load it under Node with a fake bridge.
 */
export const WORKFLOW_RUNTIME_SOURCE = `class WorkflowError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
    this.fatal = true
  }
}

function isFatal(error) {
  return error instanceof WorkflowError
}

function unwrap(reply) {
  if (reply.ok) return reply.value
  throw new WorkflowError(reply.message, reply.code)
}

export async function runWorkflow(host, input, workflow) {
  const { args, maxItemsPerCall, maxTotalAgents } = input
  let currentPhase
  let accepted = 0

  const agent = async (prompt, opts) => {
    // Mirrors the host cap (the authority) so a loop of unawaited calls issues
    // at most maxTotalAgents bridge RPCs.
    if (accepted >= maxTotalAgents) {
      throw new WorkflowError('this run reached its total agent cap (' + maxTotalAgents + ') — a runaway-loop backstop; split the work across runs if the scale is intentional', 'AGENT_CAP')
    }
    accepted += 1
    let reply
    try {
      reply = await host.agent(prompt, opts === undefined ? null : opts, currentPhase ?? null)
    } catch (error) {
      // The bridge could not carry the arguments (functions, class instances).
      throw new WorkflowError('agent() arguments must be plain JSON data — ' + String(error?.message ?? error), 'INVALID_ARGUMENT')
    }
    return unwrap(reply)
  }

  const assertItemCap = (length, hook) => {
    if (length > maxItemsPerCall) {
      throw new WorkflowError(hook + ' received ' + length + ' items — over the per-call cap (' + maxItemsPerCall + '); split the work', 'ITEM_CAP')
    }
  }

  const parallel = async thunks => {
    if (!Array.isArray(thunks)) throw new WorkflowError('parallel() requires an array of zero-argument functions', 'INVALID_ARGUMENT')
    assertItemCap(thunks.length, 'parallel()')
    thunks.forEach((thunk, index) => {
      if (typeof thunk !== 'function') throw new WorkflowError('parallel() item ' + index + ' is not a function', 'INVALID_ARGUMENT')
    })
    return Promise.all(thunks.map(async thunk => {
      try {
        return await thunk()
      } catch (error) {
        if (isFatal(error)) throw error
        return null
      }
    }))
  }

  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items)) throw new WorkflowError('pipeline() requires an items array', 'INVALID_ARGUMENT')
    assertItemCap(items.length, 'pipeline()')
    if (stages.length === 0) throw new WorkflowError('pipeline() requires at least one stage function', 'INVALID_ARGUMENT')
    stages.forEach((stage, index) => {
      if (typeof stage !== 'function') throw new WorkflowError('pipeline() stage ' + index + ' is not a function', 'INVALID_ARGUMENT')
    })
    return Promise.all(items.map(async (item, index) => {
      let value = item
      try {
        for (const stage of stages) value = await stage(value, item, index)
        return value
      } catch (error) {
        if (isFatal(error)) throw error
        return null
      }
    }))
  }

  // Progress narration is fire-and-forget; bound the RPCs in flight so a
  // loop cannot flood the host (the host also caps the events it emits).
  let progressInFlight = 0
  const report = send => {
    if (progressInFlight >= ${MAX_PROGRESS_IN_FLIGHT}) return
    progressInFlight += 1
    send().catch(() => {}).finally(() => { progressInFlight -= 1 })
  }

  const phase = title => {
    if (typeof title !== 'string' || title.length === 0) throw new WorkflowError('phase() requires a non-empty title string', 'INVALID_ARGUMENT')
    currentPhase = title
    report(() => host.phase(title))
  }

  const log = message => {
    if (typeof message !== 'string') throw new WorkflowError('log() requires a message string', 'INVALID_ARGUMENT')
    report(() => host.log(message))
  }

  const value = await workflow({ agent, parallel, pipeline, phase, log, args })
  // Wrapped: Workers RPC attaches a disposer to the top-level returned object only.
  return { value: value === undefined ? null : value }
}
`

/**
 * Wrap the model's body as the module's default async function. No newline
 * after the opening brace keeps error line numbers aligned with the script.
 */
export function workflowBodySource(body: string): string {
  return `export default async function workflow({ agent, parallel, pipeline, phase, log, args }) {${body}\n}\n`
}
