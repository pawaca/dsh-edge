/**
 * Source of the modules a workflow run loads into its own Dynamic Worker.
 *
 * The isolate holds only the script and these hooks. Everything that protects
 * the Durable Object (argument validation, agent caps, concurrency, child
 * lifecycle, events) runs on the host behind the bridge the entrypoint
 * receives, so a script that tampers with this runtime only affects its own
 * isolate. Every path across the bridge is bounded in both count and bytes:
 * agent requests, progress messages, and the result are copied into fresh
 * plain data with primitives captured before the script loads, measured while
 * copied, and only the copy is sent; the host re-checks every bound, caps the
 * child results it replies with, and stays the authority. The hook semantics mirror the published worker-thread engine:
 * fatal `WorkflowError`s propagate through `parallel()` and `pipeline()`,
 * while ordinary failures become per-item `null`.
 */

/** Module names inside the workflow isolate. */
export const WORKFLOW_ENTRY_MODULE = 'workflow-entry.js'
export const WORKFLOW_RUNTIME_MODULE = 'workflow-runtime.js'
export const WORKFLOW_BODY_MODULE = 'workflow-body.js'

/** Progress RPCs (`phase`/`log`) the isolate keeps in flight at once; extra calls are dropped. */
export const MAX_PROGRESS_IN_FLIGHT = 64
/** Largest JSON-encoded `agent()` request (prompt, options, phase) that may cross the bridge. */
export const MAX_AGENT_REQUEST_BYTES = 256 * 1024
/** Longest `phase()`/`log()` text that crosses the bridge; longer text is clipped. */
export const MAX_PROGRESS_CHARS = 4096
/** Largest JSON-encoded script result that may cross the bridge. */
export const MAX_RESULT_BYTES = 1024 * 1024
/** Largest JSON-encoded child result the host sends back to the isolate. */
export const MAX_AGENT_REPLY_BYTES = 2 * 1024 * 1024

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

// Captured when this module loads, before the body module evaluates, so a
// script that replaces JSON, Object, Array, or String members cannot change
// how bridge payloads are copied and measured.
const captured = {
  keys: Object.keys,
  getPrototypeOf: Object.getPrototypeOf,
  symbols: Object.getOwnPropertySymbols,
  defineProperty: Object.defineProperty,
  isArray: Array.isArray,
  charCodeAt: Function.prototype.call.bind(String.prototype.charCodeAt),
  slice: Function.prototype.call.bind(String.prototype.slice),
}

function utf8Length(text) {
  let size = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = captured.charCodeAt(text, index)
    if (code < 0x80) size += 1
    else if (code < 0x800) size += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      size += 4
      index += 1
    } else size += 3
  }
  return size
}

/**
 * Return a copier that turns values into fresh plain JSON data within one
 * byte budget. Only the copy crosses the bridge: every property is read once,
 * so getters, proxies, and toJSON hooks cannot change what was measured.
 */
function boundedCopier(limit, what, code) {
  let left = limit
  const fail = (path, reason) => {
    throw new WorkflowError(what + ' ' + path + ': ' + reason, code)
  }
  const spend = amount => {
    left -= amount
    if (left < 0) throw new WorkflowError(what + ' is over the ' + limit + '-byte limit; pass smaller inputs or references', code)
  }
  const copy = (item, path, ancestors) => {
    switch (typeof item) {
      case 'string':
        spend(utf8Length(item) + 2)
        return item
      case 'number':
        if (item !== item || item === Infinity || item === -Infinity) fail(path, 'non-finite numbers are not JSON data')
        spend(('' + item).length)
        return item
      case 'boolean':
        spend(5)
        return item
      case 'object':
        break
      default:
        fail(path, typeof item + ' values are not JSON data')
    }
    if (item === null) {
      spend(4)
      return null
    }
    for (let node = ancestors; node !== null; node = node.parent) {
      if (node.item === item) fail(path, 'circular references are not JSON data')
    }
    if (captured.symbols(item).length > 0) fail(path, 'symbol-keyed properties are not JSON data')
    const chain = { item, parent: ancestors }
    const define = (target, key, value) => {
      captured.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
    }
    if (captured.isArray(item)) {
      const length = item.length
      const out = []
      spend(2)
      for (let index = 0; index < length; index += 1) {
        if (!(index in item)) fail(path + '[' + index + ']', 'sparse arrays are not JSON data')
        define(out, index, copy(item[index], path + '[' + index + ']', chain))
        spend(1)
      }
      return out
    }
    const proto = captured.getPrototypeOf(item)
    if (proto !== null && captured.getPrototypeOf(proto) !== null) fail(path, 'only plain objects and arrays are JSON data')
    const out = {}
    spend(2)
    const keys = captured.keys(item)
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]
      spend(utf8Length(key) + 4)
      define(out, key, copy(item[key], path + '.' + key, chain))
    }
    return out
  }
  return value => copy(value, '', null)
}

function clip(text) {
  return text.length > ${MAX_PROGRESS_CHARS} ? captured.slice(text, 0, ${MAX_PROGRESS_CHARS}) + '…' : text
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
    // Only these fresh copies cross the bridge, measured against one request budget.
    const copy = boundedCopier(${MAX_AGENT_REQUEST_BYTES}, 'agent() request', 'INVALID_ARGUMENT')
    const sentPrompt = copy(prompt)
    const sentOpts = opts === undefined ? null : copy(opts)
    const sentPhase = currentPhase === undefined ? null : copy(currentPhase)
    accepted += 1
    let reply
    try {
      reply = await host.agent(sentPrompt, sentOpts, sentPhase)
    } catch (error) {
      throw new WorkflowError('agent() request could not cross the bridge — ' + String(error?.message ?? error), 'INVALID_ARGUMENT')
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
    currentPhase = clip(title)
    report(() => host.phase(currentPhase))
  }

  const log = message => {
    if (typeof message !== 'string') throw new WorkflowError('log() requires a message string', 'INVALID_ARGUMENT')
    const text = clip(message)
    report(() => host.log(text))
  }

  const value = await workflow({ agent, parallel, pipeline, phase, log, args })
  // Wrapped: Workers RPC attaches a disposer to the top-level returned object only.
  const result = boundedCopier(${MAX_RESULT_BYTES}, 'the workflow result', 'RESULT_UNSERIALIZABLE')(value === undefined ? null : value)
  return { value: result }
}
`

/**
 * Wrap the model's body as the module's default async function. No newline
 * after the opening brace keeps error line numbers aligned with the script.
 */
export function workflowBodySource(body: string): string {
  return `export default async function workflow({ agent, parallel, pipeline, phase, log, args }) {${body}\n}\n`
}
