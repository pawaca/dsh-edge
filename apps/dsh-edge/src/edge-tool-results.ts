/** Byte-bounded, live-only Trajectory inspection over the public result/event seams. */
import { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionToolResultRequest, SessionToolResultValue } from '@deepseek-ai/dsh-client-ui-trajectory'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export const TOOL_RESULT_LIMITS = { result: 256 * 1024, session: 1024 * 1024, total: 4 * 1024 * 1024, count: 128 } as const
interface Entry { json: string; bytes: number }
interface State { values: Map<string | number, Entry>; bytes: number; listeners: Set<() => void> }

/** Refuse before serialization can allocate an unbounded JSON string. Traversal,
 * depth and each string are bounded too. Only JSON values from tools/result enter.
 */
export function boundedToolResult(value: JsonValue): Entry | undefined {
  let remaining = TOOL_RESULT_LIMITS.result as number
  let nodes = 0
  const encoder = new TextEncoder()
  function visit(item: JsonValue, depth: number): boolean {
    if (++nodes > 16384 || depth > 64 || remaining < 0) return false
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      remaining -= String(item).length
    } else if (typeof item === 'string') {
      if (item.length > remaining) return false
      remaining -= encoder.encode(JSON.stringify(item)).byteLength
    } else if (Array.isArray(item)) {
      remaining -= 2 + Math.max(0, item.length - 1)
      if (remaining < 0) return false
      for (const child of item) if (!visit(child, depth + 1)) return false
    } else {
      remaining -= 2
      let count = 0
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue
        remaining -= 1 + (count++ > 0 ? 1 : 0)
        if (!visit(key, depth + 1) || !visit(item[key]!, depth + 1)) return false
      }
    }
    return remaining >= 0
  }
  if (!visit(value, 0)) return undefined
  const json = JSON.stringify(value)
  const bytes = encoder.encode(json).byteLength
  return bytes <= TOOL_RESULT_LIMITS.result ? { json, bytes } : undefined
}

export class EdgeToolResults extends TypertRemoteService {
  static inject = ['sessions', 'typert']
  private readonly states = new Map<Session, State>()
  private bytes = 0
  private followers = 0
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'sessionToolResults', { namespace: 'toolResults' })
    ctx.on('tools/result', (exec, result) => {
      const session = exec.agent?.session
      if (result.isError || session === undefined || ctx.sessions.get(session.id) !== session) return
      const entry = boundedToolResult(result.value)
      if (entry === undefined) return
      const state = this.state(session)
      this.remove(state, exec.callId)
      while (state.values.size >= TOOL_RESULT_LIMITS.count || state.bytes + entry.bytes > TOOL_RESULT_LIMITS.session) this.remove(state, state.values.keys().next().value!)
      while (this.bytes + entry.bytes > TOOL_RESULT_LIMITS.total) {
        const oldest = [...this.states.values()].find(candidate => candidate.values.size > 0)!
        this.remove(oldest, oldest.values.keys().next().value!)
      }
      state.values.set(exec.callId, entry)
      state.bytes += entry.bytes
      this.bytes += entry.bytes
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      const key = event.type === 'tool/result' ? event.data.message.toolCallId : event.type === 'tool/ptc-dispatch' ? event.data.subCallId : undefined
      if (key === undefined) return
      const state = this.states.get(session)
      const entry = state?.values.get(key)
      if (state === undefined || entry === undefined) return
      state.values.delete(key)
      state.values.set(event.seq, entry)
      for (const listener of state.listeners) listener()
    }, { global: true })
    ctx.on('session/disposed', session => {
      const state = this.states.get(session)
      if (state === undefined) return
      this.bytes -= state.bytes
      state.bytes = 0
      state.values.clear()
      this.states.delete(session)
      for (const listener of state.listeners) listener()
    }, { global: true })
    ctx.effect(() => () => {
      this.lifetime.abort()
      for (const state of this.states.values()) state.values.clear()
      this.states.clear()
      this.bytes = 0
    })
  }

  private state(session: Session): State {
    let state = this.states.get(session)
    if (state === undefined) {
      state = { values: new Map(), bytes: 0, listeners: new Set() }
      this.states.set(session, state)
    }
    return state
  }

  private remove(state: State, key: string | number): void {
    const entry = state.values.get(key)
    if (entry === undefined) return
    state.values.delete(key)
    state.bytes -= entry.bytes
    this.bytes -= entry.bytes
    for (const listener of state.listeners) listener()
  }

  async *watch(request: SessionToolResultRequest, signal: AbortSignal): AsyncIterable<SessionToolResultValue> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined || this.followers >= 16) { yield { available: false }; return }
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    if (lifetime.aborted) return
    const state = this.state(session)
    let update = Promise.withResolvers<void>()
    const wake = () => update.resolve()
    state.listeners.add(wake)
    lifetime.addEventListener('abort', wake, { once: true })
    this.followers++
    try {
      while (!lifetime.aborted) {
        const entry = state.values.get(request.seq)
        yield entry === undefined ? { available: false } : { available: true, value: JSON.parse(entry.json) as JsonValue }
        await update.promise
        update = Promise.withResolvers<void>()
      }
    } finally {
      this.followers--
      state.listeners.delete(wake)
      lifetime.removeEventListener('abort', wake)
    }
  }
}
