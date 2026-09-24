/**
 * Source of the modules a code run loads into its own Dynamic Worker.
 *
 * The program is the body of an async function whose parameters are the
 * binding namespaces, their error classes, and `console`, matching the
 * published worker-thread runtime. The isolate holds only the program and
 * this runtime. Everything that protects the Durable Object (binding lookup,
 * call caps, argument and reply bytes, the output ledger) runs on the host
 * behind the bridge; the checks here give well-behaved programs fast,
 * specific failures and keep what crosses the bridge a bounded plain copy.
 */
import { ISOLATE_COPY_SOURCE } from './edge-isolate-copy.ts'

/** Module names inside the code-run isolate. */
export const CODE_ENTRY_MODULE = 'code-entry.js'
export const CODE_RUNTIME_MODULE = 'code-runtime.js'
export const CODE_PROGRAM_MODULE = 'code-program.js'

/** Log RPCs the isolate keeps queued at once; the host ledger still decides what is kept. */
export const MAX_LOGS_IN_FLIGHT = 64
/** Longest text one console call sends to the host. */
export const MAX_LOG_CHARS = 64 * 1024
/** Longest exception text the isolate reports. */
export const MAX_EXCEPTION_CHARS = 16 * 1024

/** Main module: a WorkerEntrypoint whose `evaluate` runs the program against the host bridge. */
export const CODE_ENTRY_SOURCE = `import { WorkerEntrypoint } from 'cloudflare:workers'
import { runProgram } from '${CODE_RUNTIME_MODULE}'
import program from '${CODE_PROGRAM_MODULE}'

export default class extends WorkerEntrypoint {
  evaluate(host, input) {
    return runProgram(host, input, program)
  }
}
`

/**
 * Binding namespaces, error classes, the console shim, and completion
 * handling. Plain JavaScript (no platform imports) so unit tests can load it
 * in a separate `node:vm` realm.
 */
export const CODE_RUNTIME_SOURCE = `${ISOLATE_COPY_SOURCE}

const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug']

class CopyFailure extends Error {
  constructor(message, overBudget) {
    super(message)
    this.overBudget = overBudget
  }
}

function raiseCopy(message, overBudget) {
  throw new CopyFailure(message, overBudget)
}

function clipText(text, max) {
  return text.length > max ? captured.slice(text, 0, max) + '…' : text
}

function render(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? String(value)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

export async function runProgram(host, input, program) {
  const { namespaces, maxBindingCalls, maxBindingArgBytes, maxCompletionBytes } = input
  let calls = 0

  const errorClasses = []
  const errorClassByGlobal = Object.create(null)
  for (const namespace of namespaces) {
    if (namespace.errorClass === undefined) continue
    const descriptor = namespace.errorClass
    const BindingCallError = class extends Error {
      constructor(memberName, message) {
        super(message)
        captured.defineProperty(this, 'name', { value: descriptor.name, enumerable: true, writable: true, configurable: true })
        captured.defineProperty(this, descriptor.memberNameProperty, { value: memberName, enumerable: true, writable: true, configurable: true })
      }
    }
    errorClassByGlobal[namespace.global] = BindingCallError
    errorClasses.push(BindingCallError)
  }

  const failure = (global, name, message) => {
    const ErrorClass = errorClassByGlobal[global]
    return ErrorClass === undefined ? new Error(message) : new ErrorClass(name, message)
  }

  const bindingObjects = namespaces.map(({ global, names }) => {
    const target = Object.create(null)
    for (const name of names) {
      captured.defineProperty(target, name, {
        enumerable: true,
        value: async args => {
          // Mirrors the host cap (the authority) so unawaited calls stop here.
          if (calls >= maxBindingCalls) {
            throw failure(global, name, 'this run reached its binding call cap (' + maxBindingCalls + ')')
          }
          let copied
          try {
            copied = boundedCopier(maxBindingArgBytes, 'binding arguments', raiseCopy)(args === undefined ? null : args)
          } catch (error) {
            throw failure(global, name, error instanceof CopyFailure ? error.message : 'binding arguments must be lossless JSON')
          }
          calls += 1
          let reply
          try {
            reply = await host.call(global, name, copied)
          } catch (error) {
            throw failure(global, name, 'binding call could not cross the bridge: ' + String(error?.message ?? error))
          }
          if (reply.ok) return reply.value
          throw failure(global, name, reply.message)
        },
      })
    }
    return target
  })

  // Log RPCs run as one ordered chain that the outcome waits for: a log sent
  // without waiting could otherwise reach the host after the run settled.
  let logsQueued = 0
  let logChain = Promise.resolve()
  const shim = Object.create(null)
  for (const level of CONSOLE_LEVELS) {
    shim[level] = (...args) => {
      if (logsQueued >= ${MAX_LOGS_IN_FLIGHT}) return
      const text = clipText(args.map(render).join(' '), ${MAX_LOG_CHARS})
      logsQueued += 1
      logChain = logChain.then(() => host.log(text)).catch(() => {}).then(() => { logsQueued -= 1 })
    }
  }
  const settle = async outcome => {
    await logChain
    return { outcome }
  }

  let value
  try {
    value = await program(...bindingObjects, ...errorClasses, shim)
  } catch (error) {
    let message
    try {
      message = error instanceof Error ? error.stack ?? error.message : String(error)
    } catch {
      message = 'program threw an unrenderable value'
    }
    return settle({ error: { kind: 'exception', message: clipText(message, ${MAX_EXCEPTION_CHARS}) } })
  }
  if (value === undefined) return settle({})
  let copied
  try {
    copied = boundedCopier(maxCompletionBytes, 'program completion', raiseCopy)(value)
  } catch (error) {
    const overBudget = error instanceof CopyFailure && error.overBudget
    return settle({
      error: overBudget
        ? { kind: 'output-limit', message: 'program completion exceeded ' + maxCompletionBytes + ' bytes' }
        : { kind: 'invalid-output', message: 'program completion must be lossless JSON — ' + String(error?.message ?? error) },
    })
  }
  return settle({ value: copied })
}
`

/**
 * Wrap a type-stripped program as the module's default async function. No
 * newline after the opening brace keeps error line numbers aligned with the
 * model's program. Modules are strict, matching the upstream `'use strict'`.
 */
export function codeProgramSource(program: string, parameters: readonly string[]): string {
  return `export default async function program(${parameters.join(', ')}) {${program}\n}\n`
}
