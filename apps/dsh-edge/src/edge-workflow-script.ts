/**
 * Compile a model-written workflow script body into an interpreted program.
 *
 * workerd rejects every runtime code-generation path (`eval`, `new Function`,
 * `node:vm`, and `WebAssembly.compile` from bytes), so the upstream
 * worker-thread engine cannot run here. The body is instead parsed and
 * tree-walked by `sval`, a pure-JavaScript interpreter, inside the Durable
 * Object isolate. That keeps Direct and Dynamic Loader deployments aligned.
 *
 * The interpreter shares the Durable Object's builtins (there is no separate
 * realm), so a mutated builtin would persist for every session until eviction.
 * The invariants this module maintains are: a script never obtains a
 * reference to a prototype object, and it can mutate only objects it created.
 * Prototypes include intrinsics no global reaches, such as the shared iterator
 * prototypes, so every route to them is closed rather than their set listed:
 * - the global scope holds only ECMAScript data builtins, with `Object`
 *   replaced by a facade whose mutators refuse builtin targets, whose
 *   `getPrototypeOf` always refuses, and whose descriptor reflection refuses
 *   builtin objects (no `Reflect`, no `__proto__`);
 * - every assignment, update, and `delete` target passes through a check that
 *   throws for any builtin reachable from those globals (constructors,
 *   prototypes, and their methods);
 * - member names that reach a constructor or prototype (`constructor`,
 *   `prototype`, `__proto__`, the legacy accessor helpers) are refused at
 *   parse time when static and checked at run time when computed;
 * - `.call`/`.apply`/`.bind` refuse a builtin receiver.
 * Residual gap: a receiver-rebinding call reached through a computed key
 * built at run time (`fn[name](builtin)`) is not checked.
 *
 * A step check injected into every loop and function body is the only way to
 * stop an interpreted hot loop: Workers freeze `Date.now()` during synchronous
 * execution, so a wall-clock deadline cannot fire, and there is no thread to
 * terminate. Work inside a single native builtin call (regex backtracking, a
 * huge `Array(n).fill()` or `repeat()`) is not step-counted; only the Workers
 * CPU and memory limits bound it, and the Durable Object's interrupted-work
 * recovery handles the resulting reset. Bounding it needs a separately
 * terminable isolate, which is the planned Dynamic Worker engine. Containment,
 * not a security boundary (the upstream engine takes the same stance): scripts
 * come from the owner's own model.
 */
import Sval from 'sval'
import { WorkflowError } from '@deepseek-ai/dsh-workflow'

/** Reserved identifier prefix for engine-injected bindings. */
const RESERVED_PREFIX = '__dsh'
const TICK = `${RESERVED_PREFIX}Tick`
const SETTLE = `${RESERVED_PREFIX}Settle`
const CAPTURE = `${RESERVED_PREFIX}Capture`
const WRITABLE = `${RESERVED_PREFIX}Writable`
const KEY = `${RESERVED_PREFIX}Key`
const RECEIVER = `${RESERVED_PREFIX}Receiver`
const SEAL = `${RESERVED_PREFIX}Seal`
/** Engine hooks: passed into the program as parameters, never left readable as globals. */
const HOOKS = [SETTLE, TICK, WRITABLE, KEY, RECEIVER] as const

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

/** Member names that lead from a value to a shared constructor or prototype. */
const FORBIDDEN_MEMBERS = new Set([
  'prototype', '__proto__', 'constructor',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
])

/** Methods that run with a caller-chosen receiver. */
const RECEIVER_METHODS = new Set(['call', 'apply', 'bind'])

/** `Object` statics that mutate their first argument. */
const OBJECT_MUTATORS = new Set([
  'defineProperty', 'defineProperties', 'assign', 'setPrototypeOf', 'freeze', 'seal', 'preventExtensions',
])

/** `Object` statics that could hand a script a builtin method through a descriptor. */
const OBJECT_REFLECTORS = new Set(['getOwnPropertyDescriptor', 'getOwnPropertyDescriptors'])

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
  const source = `(async () => {${body}\n})()`
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
  const hosted = hostProgram(program)
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
        [WRITABLE]: assertWritable,
        [KEY]: assertKey,
        [RECEIVER]: assertReceiver,
        [SETTLE]: (promise: Promise<unknown>) => { completion ??= promise },
        // Imported globals are properties of the object the script sees as `this` and
        // `globalThis`; clear every hook before the body runs so none is reachable.
        [SEAL]: () => {
          interpreter.import(Object.fromEntries([...HOOKS, SEAL].map(hook => [hook, undefined])))
        },
      })
      interpreter.run(hosted as never)
      if (typeof (completion as { then?: unknown } | undefined)?.then !== 'function') {
        throw new Error('workflow script did not produce a completion promise')
      }
      return completion!
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
  global.Object = objectFacade()
}

let builtins: WeakSet<object> | undefined
let facade: ObjectConstructor | undefined

/** Every object reachable from the allowlisted globals: constructors, prototypes, methods, accessors. */
function sharedBuiltins(): WeakSet<object> {
  if (builtins !== undefined) return builtins
  const seen = new WeakSet<object>()
  const queue: unknown[] = [...ALLOWED_GLOBALS].map(name => (globalThis as Record<string, unknown>)[name])
  while (queue.length > 0) {
    const value = queue.pop()
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value)) continue
    seen.add(value)
    queue.push(Object.getPrototypeOf(value))
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) continue
      // Accessor functions are collected as values, never invoked.
      const { value: data, get: getter, set: setter } = descriptor as { value?: unknown, get?: unknown, set?: unknown }
      queue.push(data, getter, setter)
    }
  }
  builtins = seen
  return seen
}

function isBuiltin(value: unknown): boolean {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && sharedBuiltins().has(value)
}

function refuse(what: string): never {
  throw new WorkflowError(`workflow scripts cannot ${what}; build and change your own objects instead`, 'INVALID_ARGUMENT')
}

/** Write-target guard: returns the object unchanged unless it is a shared builtin. */
function assertWritable<T>(target: T): T {
  if (isBuiltin(target)) refuse('modify built-in objects')
  return target
}

/** Computed-key guard: resolves the key once and refuses names that reach a constructor or prototype. */
function assertKey(key: unknown): unknown {
  const resolved = typeof key === 'symbol' ? key : String(key)
  if (typeof resolved === 'string' && FORBIDDEN_MEMBERS.has(resolved)) refuse(`access "${resolved}"`)
  return resolved
}

/** Receiver guard for `.call`/`.apply`/`.bind`. */
function assertReceiver<T>(receiver: T): T {
  if (isBuiltin(receiver)) refuse('call a method on a built-in object')
  return receiver
}

/**
 * The script's `Object`: the real constructor behind a proxy whose mutators
 * refuse builtin targets and whose reflection refuses builtin objects.
 * Shared across runs, so it and its wrappers are themselves protected.
 */
function objectFacade(): ObjectConstructor {
  if (facade !== undefined) return facade
  const shared = sharedBuiltins()
  const wrappers = new Map<PropertyKey, unknown>()
  for (const name of OBJECT_MUTATORS) {
    const original = (Object as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!
    wrappers.set(name, Object.freeze((...args: unknown[]) => original(assertWritable(args[0]), ...args.slice(1))))
  }
  for (const name of OBJECT_REFLECTORS) {
    const original = (Object as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!
    wrappers.set(name, Object.freeze((...args: unknown[]) => {
      if (isBuiltin(args[0])) refuse(`inspect built-in objects with Object.${name}`)
      const result = original(...args)
      if (isBuiltin(result)) refuse(`reach built-in prototypes with Object.${name}`)
      return result
    }))
  }
  // Builtin factories produce prototypes no global reaches (%ArrayIteratorPrototype% and
  // friends), so prototype reflection is refused outright rather than filtered.
  wrappers.set('getPrototypeOf', Object.freeze(() => refuse('read prototypes with Object.getPrototypeOf')))
  const readOnly = () => refuse('modify built-in objects')
  facade = new Proxy(Object, {
    get: (target, key, receiver) => wrappers.has(key) ? wrappers.get(key) : Reflect.get(target, key, receiver) as unknown,
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
    setPrototypeOf: readOnly,
  })
  shared.add(facade)
  for (const wrapper of wrappers.values()) shared.add(wrapper as object)
  return facade
}

/**
 * Wrap the instrumented body call so the hooks arrive as parameters of an
 * outer arrow, whose first statement clears them from the global scope:
 * `((__dshSettle, __dshTick, …) => { __dshSeal(); __dshSettle(<body call>) })(__dshSettle, __dshTick, …)`.
 */
function hostProgram(program: AstNode): AstNode {
  const bodyCall = ((program.body as AstNode[])[0]?.expression) as AstNode
  const identifier = (name: string): AstNode => ({ type: 'Identifier', name })
  const call = (callee: AstNode, args: AstNode[]): AstNode => ({ type: 'CallExpression', callee, arguments: args, optional: false })
  const statement = (expression: AstNode): AstNode => ({ type: 'ExpressionStatement', expression })
  const host: AstNode = {
    type: 'ArrowFunctionExpression',
    id: null,
    params: HOOKS.map(identifier),
    body: block([statement(call(identifier(SEAL), [])), statement(call(identifier(SETTLE), [bodyCall]))]),
    expression: false,
    async: false,
    generator: false,
  }
  return { type: 'Program', sourceType: 'script', body: [statement(call(host, HOOKS.map(identifier)))] }
}

/** Return the first refused construct, or undefined when the script is acceptable. */
function findViolation(root: AstNode): string | undefined {
  const statements = root.body as AstNode[]
  const only = statements[0]?.expression as AstNode | undefined
  // A body that closes the wrapper early would run code outside it.
  if (statements.length !== 1 || only?.type !== 'CallExpression'
    || (only.callee as AstNode).type !== 'ArrowFunctionExpression') {
    return 'the script body must not close its wrapper function'
  }
  let found: string | undefined
  walk(root, node => {
    if (found !== undefined) return
    if (node.type === 'Identifier' && typeof node.name === 'string'
      && node.name.startsWith(RESERVED_PREFIX)) {
      found = `identifiers starting with "${RESERVED_PREFIX}" are reserved (${node.name})`
      return
    }
    if (node.type === 'WithStatement') {
      found = '`with` statements are not available in workflow scripts'
      return
    }
    const keys: (string | undefined)[] = []
    if (node.type === 'MemberExpression') keys.push(staticKey(node.property as AstNode, node.computed === true))
    if (node.type === 'ObjectPattern') {
      for (const property of node.properties as AstNode[]) {
        if (property.type === 'Property') keys.push(staticKey(property.key as AstNode, property.computed === true))
      }
    }
    const forbidden = keys.find(key => key !== undefined && FORBIDDEN_MEMBERS.has(key))
    if (forbidden !== undefined) {
      found = `access to "${forbidden}" is not available in workflow scripts`
      return
    }
    if (node.type === 'CallExpression' && isReceiverCall(node)
      && (node.arguments as AstNode[])[0]?.type === 'SpreadElement') {
      found = 'spreading the receiver argument of call/apply/bind is not available in workflow scripts'
    }
  })
  return found
}

/** The name a non-computed or literal key denotes, or undefined for a key known only at run time. */
function staticKey(key: AstNode, computed: boolean): string | undefined {
  if (!computed) return key.type === 'Identifier' ? key.name as string : String(key.value)
  return key.type === 'Literal' ? String(key.value) : undefined
}

function isReceiverCall(node: AstNode): boolean {
  const callee = node.callee as AstNode
  if (callee.type !== 'MemberExpression') return false
  const key = staticKey(callee.property as AstNode, callee.computed === true)
  return key !== undefined && RECEIVER_METHODS.has(key)
}

/**
 * Insert a step check at the head of every loop iteration and function body,
 * and route write targets, run-time computed keys, and call/apply/bind
 * receivers through their guards.
 */
function instrument(root: AstNode): void {
  walk(root, node => {
    switch (node.type) {
      case 'AssignmentExpression':
        guardWriteTarget(node.left as AstNode)
        break
      case 'UpdateExpression':
        guardWriteTarget(node.argument as AstNode)
        break
      case 'UnaryExpression':
        if (node.operator === 'delete') guardWriteTarget(node.argument as AstNode)
        break
      case 'ForInStatement':
      case 'ForOfStatement':
        guardWriteTarget(node.left as AstNode)
        break
      case 'MemberExpression':
        if (node.computed === true && (node.property as AstNode).type !== 'Literal') {
          node.property = guardCall(KEY, node.property as AstNode)
        }
        break
      case 'Property':
        if (node.computed === true && (node.key as AstNode).type !== 'Literal') {
          node.key = guardCall(KEY, node.key as AstNode)
        }
        break
      case 'CallExpression':
        if (isReceiverCall(node)) {
          const args = node.arguments as AstNode[]
          if (args[0] !== undefined) args[0] = guardCall(RECEIVER, args[0])
        }
        break
    }
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

/** Wrap the object of every member expression a pattern writes to. */
function guardWriteTarget(target: AstNode): void {
  switch (target.type) {
    case 'MemberExpression':
      if ((target.object as AstNode).type !== 'Super') target.object = guardCall(WRITABLE, target.object as AstNode)
      break
    case 'ObjectPattern':
      for (const property of target.properties as AstNode[]) {
        guardWriteTarget(property.type === 'Property' ? property.value as AstNode : property)
      }
      break
    case 'ArrayPattern':
      for (const element of target.elements as (AstNode | null)[]) if (element !== null) guardWriteTarget(element)
      break
    case 'RestElement':
      guardWriteTarget(target.argument as AstNode)
      break
    case 'AssignmentPattern':
      guardWriteTarget(target.left as AstNode)
      break
  }
}

function guardCall(guard: string, argument: AstNode): AstNode {
  return {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: guard },
    arguments: [argument],
    optional: false,
  }
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
