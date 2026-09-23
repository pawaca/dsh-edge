/**
 * Compile a model-written workflow script body into an interpreted program.
 *
 * workerd rejects every runtime code-generation path (`eval`, `new Function`,
 * `node:vm`, and `WebAssembly.compile` from bytes), so the upstream
 * worker-thread engine cannot run here. The body is instead parsed and
 * tree-walked by `sval`, a pure-JavaScript interpreter, inside the Durable
 * Object isolate. That keeps Direct and Dynamic Loader deployments aligned.
 *
 * Containment, not a security boundary (the upstream engine takes the same
 * stance): the interpreter shares the host realm's builtins, so this module
 * narrows the script's global scope to plain ECMAScript data builtins, rejects
 * prototype writes by name, and injects a step check into every loop and
 * function body. The step check is the only way to stop a synchronous hot loop:
 * Workers freeze `Date.now()` during synchronous execution, so a wall-clock
 * deadline cannot fire, and there is no thread to terminate.
 *
 * Residual risk, larger than the upstream vm realm's: the name-based
 * prototype check does not see indirect paths such as
 * `Object.getPrototypeOf([])` or computed keys, and a builtin mutation made
 * that way persists for every session in the Durable Object until eviction.
 * Scripts are written by the owner's own model; treat them as trusted input
 * with guard rails, not as isolated code.
 */
import Sval from 'sval'
import { WorkflowError } from '@deepseek-ai/dsh-workflow'

/** Reserved identifier prefix for engine-injected bindings. */
const RESERVED_PREFIX = '__dsh'
const TICK = `${RESERVED_PREFIX}Tick`
const SETTLE = `${RESERVED_PREFIX}Settle`
const CAPTURE = `${RESERVED_PREFIX}Capture`

/** A body that still carries the Claude Code-style meta header (meta rides the request as data). */
const META_STATEMENT = /^\s*export\s+const\s+meta\b/u

/**
 * Global names the script may read. Everything else the interpreter copies
 * from the host global object is removed from the per-run global scope:
 * network, timers, storage, and runtime APIs are not available to workflow scripts.
 */
const ALLOWED_GLOBALS = new Set([
  'Object', 'Array', 'Promise', 'JSON', 'Math', 'Number', 'String', 'Boolean',
  'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'AggregateError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN',
  'Infinity', 'undefined', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI',
])

/** Member names whose use would let a script mutate shared host builtins. */
const FORBIDDEN_MEMBERS = new Set(['prototype', '__proto__'])

const LOOP_TYPES = new Set([
  'WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
])
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
])

interface AstNode {
  type: string
  [key: string]: unknown
}

/** The host bindings one run exposes to its script. */
export interface WorkflowScriptBindings {
  readonly agent: (...args: unknown[]) => unknown
  readonly parallel: (...args: unknown[]) => unknown
  readonly pipeline: (...args: unknown[]) => unknown
  readonly phase: (...args: unknown[]) => unknown
  readonly log: (...args: unknown[]) => unknown
  readonly args: unknown
  /** Called at the start of every loop iteration and function body; throws to stop the script. */
  readonly tick: () => void
}

/** A parsed, validated, and instrumented script for exactly one run. */
export interface WorkflowProgram {
  /**
   * Evaluate the program against the run's bindings. Single use: the
   * instrumented AST belongs to one run.
   * @returns the script body's completion promise.
   */
  run(bindings: WorkflowScriptBindings): Promise<unknown>
}

/**
 * Parse, lint, and instrument a workflow body. Throws `SCRIPT_PARSE` for a
 * body that does not compile or uses a construct this engine refuses.
 * @param body - the plain-JS script body (top-level await, ends with `return`).
 * @param name - the validated meta name (used in error messages).
 * @returns a program whose `run` evaluates the instrumented AST.
 */
export function compileWorkflowScript(body: string, name: string): WorkflowProgram {
  if (META_STATEMENT.test(body)) {
    throw new WorkflowError(
      'workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body',
      'SCRIPT_PARSE',
    )
  }
  // No newline before the body keeps parser line numbers aligned with the model's script.
  const source = `${SETTLE}((async () => {${body}\n})())`
  let program: AstNode
  try {
    program = createInterpreter().parse(source) as unknown as AstNode
  } catch (error) {
    throw new WorkflowError(
      `workflow script "${name}" does not parse: ${String(error)}`,
      'SCRIPT_PARSE',
      { cause: error },
    )
  }
  const violation = findViolation(program)
  if (violation !== undefined) {
    throw new WorkflowError(`workflow script "${name}" is not supported: ${violation}`, 'SCRIPT_PARSE')
  }
  instrument(program)
  let consumed = false
  return {
    run(bindings) {
      if (consumed) throw new Error('a compiled workflow program runs once')
      consumed = true
      const interpreter = createInterpreter()
      restrictGlobals(interpreter)
      let completion: Promise<unknown> | undefined
      interpreter.import({
        agent: bindings.agent,
        parallel: bindings.parallel,
        pipeline: bindings.pipeline,
        phase: bindings.phase,
        log: bindings.log,
        args: bindings.args,
        [TICK]: bindings.tick,
        [SETTLE]: (promise: Promise<unknown>) => { completion = promise },
      })
      interpreter.run(program as never)
      if (completion === undefined) throw new Error('workflow script did not produce a completion promise')
      return completion
    },
  }
}

function createInterpreter(): Sval {
  return new Sval({ ecmaVer: 'latest', sourceType: 'script', sandBox: true })
}

/** Remove every non-allowlisted name from the interpreter's own global object copy. */
function restrictGlobals(interpreter: Sval): void {
  let global: Record<string, unknown> | undefined
  interpreter.import(CAPTURE, (value: Record<string, unknown>) => { global = value })
  interpreter.run(`${CAPTURE}(globalThis)`)
  // Imported bindings become non-configurable globals, so the capture hook is cleared rather than deleted.
  interpreter.import(CAPTURE, undefined)
  if (global === undefined) throw new Error('workflow interpreter did not expose its global scope')
  for (const key of Object.getOwnPropertyNames(global)) {
    if (!ALLOWED_GLOBALS.has(key) && key !== CAPTURE) delete global[key]
  }
}

/** Return the first refused construct, or undefined when the script is acceptable. */
function findViolation(root: AstNode): string | undefined {
  // The wrapper's own settle callee is the only reserved identifier allowed.
  const wrapper = ((root.body as AstNode[])[0]?.expression as AstNode | undefined)?.callee
  let found: string | undefined
  walk(root, node => {
    if (found !== undefined) return
    if (node.type === 'Identifier' && node !== wrapper && typeof node.name === 'string'
      && node.name.startsWith(RESERVED_PREFIX)) {
      found = `identifiers starting with "${RESERVED_PREFIX}" are reserved (${node.name})`
      return
    }
    if (node.type === 'MemberExpression') {
      const property = node.property as AstNode
      const key = node.computed === true
        ? (property.type === 'Literal' ? String(property.value) : undefined)
        : (property.type === 'Identifier' ? property.name as string : undefined)
      if (key !== undefined && FORBIDDEN_MEMBERS.has(key)) {
        found = `access to "${key}" is not available in workflow scripts`
      }
    }
  })
  return found
}

/** Insert a step check at the head of every loop iteration and function body. */
function instrument(root: AstNode): void {
  walk(root, node => {
    if (LOOP_TYPES.has(node.type)) {
      node.body = block([tickStatement(), node.body as AstNode])
      return
    }
    if (!FUNCTION_TYPES.has(node.type)) return
    const body = node.body as AstNode
    if (body.type === 'BlockStatement') {
      (body.body as AstNode[]).unshift(tickStatement())
    } else {
      node.body = block([tickStatement(), { type: 'ReturnStatement', argument: body }])
      node.expression = false
    }
  })
}

function tickStatement(): AstNode {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: TICK },
      arguments: [],
      optional: false,
    },
  }
}

function block(body: AstNode[]): AstNode {
  return { type: 'BlockStatement', body }
}

/** Depth-first pre-order walk over ESTree nodes (children are collected before the visitor mutates). */
function walk(root: AstNode, visit: (node: AstNode) => void): void {
  const stack: AstNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    const children: AstNode[] = []
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || value === null || typeof value !== 'object') continue
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) children.push(item)
      } else if (isNode(value)) {
        children.push(value)
      }
    }
    visit(node)
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!)
  }
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}
