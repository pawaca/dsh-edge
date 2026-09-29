/**
 * Edge-owned settings service behind the upstream `ctx.settings` seam.
 *
 * Upstream 0.2.0 replaced its settings provider with `SettingsForms`, which
 * stores plugin configuration in a launcher profile on disk. The Edge has no
 * launcher profile, so it serves the seam itself: one JSON document in Durable
 * Object KV (the same key the earlier provider used, so stored settings carry
 * over unchanged), per-namespace registration for Edge-owned settings, and the
 * describe/update/replace/mutate surface the Settings page calls.
 *
 * Resolution layers schema defaults, the registrant's `base`, then the user
 * section. Writes to one namespace run in order; `expectedRevision` refuses a
 * stale write with the upstream `SettingsConflictError`.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import {
  SettingsConflictError,
  redactSecrets,
  type SettingsDescribeOptions,
  type SettingsDescriptor,
  type SettingsNamespace,
  type SettingsPathOp,
} from '@deepseek-ai/dsh-settings'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { deepEqualJson, deepFreeze } from '@deepseek-ai/dsh-util-values'

export const SETTINGS_DOCUMENT_KEY = 'dsh-edge:settings-document'
/** Schemastery's parse modes (not exported by the package); volatile schemas parse to references. */
type SchemaMode = 'plain' | 'defined' | 'volatile' | 'volatile-defined'
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/u

/** Owner-facing handle for one registered namespace. */
export interface EdgeSettingsScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user section. */
  get(): T
  /** Observe committed changes; callbacks run one at a time, in commit order. */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  /** Merge a patch into this namespace's user section. */
  update(patch: object): Promise<void>
  /** Replace this namespace's user section wholesale. */
  replace(section: object): Promise<void>
}

export interface EdgeSettingsRegisterOptions<T> {
  /** Values resolved below the user section. */
  base?: Partial<T>
  /** Reject a resolved value the schema cannot express as invalid; refuses the write. */
  validate?: (value: T) => void
}

interface Watcher {
  callback: (next: unknown, prev: unknown) => void | Promise<void>
  tail: Promise<void>
  active: boolean
}

interface Registration {
  ns: SettingsNamespace
  schema: z<unknown>
  base: unknown
  validate?: (value: unknown) => void
  resolved: unknown
  revision: number
  watchers: Set<Watcher>
}

/** The Edge settings service; resolve it with {@link edgeSettings}. */
export class EdgeSettings extends Service {
  /** The Edge persists every write. */
  readonly writable = true
  private readonly registrations = new Map<SettingsNamespace, Registration>()
  private readonly queues = new Map<SettingsNamespace, Promise<unknown>>()
  private readonly pending = new Set<Promise<void>>()
  private document: Record<string, unknown> = {}
  private stopped = false

  constructor(ctx: Context, private readonly config: { storage: DurableObjectStorage }) {
    super(ctx, 'settings')
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => {
      this.stopped = true
      await Promise.allSettled([...this.queues.values(), ...this.pending])
    }
    const stored = await this.config.storage.get(SETTINGS_DOCUMENT_KEY)
    this.document = isPlainObject(stored) ? stored : {}
  }

  /**
   * Register one Edge-owned namespace. A stored section that fails validation rejects registration.
   * The scope serves the schema's input shape: live (volatile) fields resolve to their plain values.
   */
  register<T>(name: string, schema: z<T, unknown, SchemaMode>, options?: EdgeSettingsRegisterOptions<T>): EdgeSettingsScope<T> {
    const ns = parseNamespace(name)
    if (this.registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
    const validate = options?.validate as ((value: unknown) => void) | undefined
    const registration: Registration = {
      ns,
      schema: schema as z<unknown>,
      base: options?.base,
      ...validate === undefined ? {} : { validate },
      resolved: deepFreeze(resolve(schema as z<unknown>, options?.base, this.section(ns), validate)),
      revision: 0,
      watchers: new Set(),
    }
    this.ctx.effect(() => {
      this.registrations.set(ns, registration)
      return () => this.registrations.delete(ns)
    }, `settings.register(${JSON.stringify(ns)})`)
    return {
      get: () => registration.resolved as T,
      watch: (callback) => {
        const watcher: Watcher = { callback: callback as Watcher['callback'], tail: Promise.resolve(), active: true }
        registration.watchers.add(watcher)
        return () => {
          watcher.active = false
          registration.watchers.delete(watcher)
        }
      },
      update: patch => this.update(ns, patch),
      replace: section => this.replace(ns, section),
    }
  }

  /**
   * Upstream plugins declare an automatic settings form here. The Edge shows
   * only its own namespaces, so this records nothing.
   * @returns a disposer, as upstream's does.
   */
  configure(): () => void {
    return () => {}
  }

  /** The Edge has no settings file to open. */
  prepareDocument(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  describe(options?: SettingsDescribeOptions): SettingsDescriptor[] {
    return [...this.registrations.values()].map((registration) => {
      const user = this.section(registration.ns)
      const base = registration.base === undefined ? undefined : structuredClone(registration.base)
      const detachedUser = user === undefined ? undefined : structuredClone(user)
      const descriptor: SettingsDescriptor = {
        ns: registration.ns,
        autoGenerate: true,
        schema: registration.schema.toJSON(),
        value: registration.resolved,
        revision: registration.revision,
        ...base === undefined ? {} : { base },
        ...detachedUser === undefined ? {} : { user: detachedUser },
        applies: 'live',
      }
      if (options?.redactSecrets !== true) return descriptor
      const schema = registration.schema as z<never>
      const redacted = redactSecrets(schema, registration.resolved)
      return {
        ...descriptor,
        value: redacted.value,
        ...base === undefined ? {} : { base: redactSecrets(schema, base).value },
        ...detachedUser === undefined ? {} : { user: redactSecrets(schema, detachedUser).value },
        secrets: redacted.secrets,
      }
    })
  }

  /** Merge a patch into one namespace's user section. */
  update(ns: string, patch: object, expectedRevision?: number): Promise<void> {
    return this.write(ns, 'merge', patch, expectedRevision)
  }

  /** Replace one namespace's user section; absent keys re-inherit `base` and defaults. */
  replace(ns: string, section: object, expectedRevision?: number): Promise<void> {
    return this.write(ns, 'replace', section, expectedRevision)
  }

  /** Apply path-addressed edits, so a caller holding a redacted view never erases a secret. */
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> {
    if (!Array.isArray(ops) || !ops.every(isPathOp)) {
      return Promise.reject(new TypeError(`settings mutate for "${ns}" ops must be {op:'set'|'unset', path: string[]}`))
    }
    return this.write(ns, 'mutate', { ops }, expectedRevision)
  }

  private write(name: string, mode: 'merge' | 'replace' | 'mutate', input: object, expectedRevision?: number): Promise<void> {
    const ns = parseNamespace(name)
    const registration = this.registrations.get(ns)
    if (registration === undefined) return Promise.reject(new Error(`settings namespace "${ns}" is not registered`))
    if (this.stopped) return Promise.reject(new Error(`settings service is disposed: "${ns}" cannot be written`))
    if (!isPlainObject(input)) return Promise.reject(new TypeError(`settings write for "${ns}" must be a plain object`))
    let snapshot: Record<string, unknown>
    try {
      snapshot = cloneJson(input, `settings write for "${ns}"`)
    } catch (error) {
      return Promise.reject(error)
    }
    const run = (this.queues.get(ns) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (this.stopped || this.registrations.get(ns) !== registration) {
        throw new Error(`settings namespace "${ns}" was disposed before its queued write ran`)
      }
      if (expectedRevision !== undefined && expectedRevision !== registration.revision) {
        throw new SettingsConflictError(ns, expectedRevision, registration.revision)
      }
      const current = this.section(ns) ?? {}
      const section = mode === 'merge'
        ? mergeLayers(current, snapshot) as Record<string, unknown>
        : mode === 'replace'
          ? snapshot
          : (snapshot['ops'] as SettingsPathOp[]).reduce(applyPathOp, current)
      const next = deepFreeze(resolve(registration.schema, registration.base, section, registration.validate))
      const document = { ...this.document, [ns]: section }
      await this.config.storage.put(SETTINGS_DOCUMENT_KEY, document)
      this.document = document
      if (!deepEqualJson(current, section)) {
        registration.revision += 1
        this.ctx.emit('settings/document-updated', ns, registration.revision)
      }
      this.commit(registration, next)
    })
    this.queues.set(ns, run)
    return run
  }

  private commit(registration: Registration, next: unknown): void {
    const prev = registration.resolved
    if (deepEqualJson(next, prev)) return
    registration.resolved = next
    for (const watcher of registration.watchers) {
      const segment = watcher.tail
        .then(() => watcher.active && !this.stopped ? watcher.callback(next, prev) : undefined)
        .then(() => undefined, (error: unknown) => {
          this.ctx.logger.warn('settings: "%s" watcher failed', registration.ns)
          this.ctx.logger.warn(error)
        })
      watcher.tail = segment
      this.pending.add(segment)
      void segment.finally(() => this.pending.delete(segment))
    }
  }

  private section(ns: SettingsNamespace): Record<string, unknown> | undefined {
    const section = this.document[ns]
    return isPlainObject(section) ? section : undefined
  }
}

/** Resolve the Edge settings service; `ctx.settings` is typed as upstream's service. */
export function edgeSettings(ctx: Context): EdgeSettings {
  return ctx.get('settings') as unknown as EdgeSettings
}

function parseNamespace(value: string): SettingsNamespace {
  if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  return value as SettingsNamespace
}

function resolve(schema: z<unknown>, base: unknown, section: Record<string, unknown> | undefined, validate?: (value: unknown) => void): unknown {
  const value = plainConfig(schema(mergeLayers(base, section) as never))
  validate?.(value)
  return value
}

/** Live (volatile) fields parse into references; serve their plain values, as upstream SettingsForms does. */
function plainConfig(value: unknown): unknown {
  if (isVolatile(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isPathOp(op: unknown): op is SettingsPathOp {
  return isPlainObject(op) && (op['op'] === 'set' || op['op'] === 'unset')
    && Array.isArray(op['path']) && (op['path'] as unknown[]).every(part => typeof part === 'string')
}

/** Layer `over` onto `under`; plain objects merge key by key and `undefined` inherits. */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  }
  return merged
}

function applyPathOp(section: Record<string, unknown>, op: SettingsPathOp): Record<string, unknown> {
  const [head, ...rest] = op.path
  if (head === undefined) {
    if (op.op === 'unset') return {}
    if (!isPlainObject(op.value)) throw new TypeError('settings mutate: setting the section root requires a plain object')
    return { ...op.value }
  }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value }
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = section[head]
  if (!isPlainObject(child)) return op.op === 'unset' ? section : { ...section, [head]: applyPathOp({}, { ...op, path: rest }) }
  return { ...section, [head]: applyPathOp(child, { ...op, path: rest }) }
}

/** Detach a write input, admitting JSON data only; `undefined` object entries are skipped. */
function cloneJson(root: Record<string, unknown>, label: string): Record<string, unknown> {
  const clone = (value: unknown, path: string, seen: Set<object>): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'object' && (Array.isArray(value) || isPlainObject(value)) && !seen.has(value)) {
      const inner = new Set(seen).add(value)
      if (Array.isArray(value)) return value.map((entry, index) => clone(entry, `${path}[${String(index)}]`, inner))
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) out[key] = clone(entry, `${path}.${key}`, inner)
      }
      return out
    }
    throw new TypeError(`${label} must contain only JSON-compatible data (found an unsupported value at ${path})`)
  }
  return clone(root, '$', new Set()) as Record<string, unknown>
}
