/** Bind browser controls to the canonical turn observed by this tab's Remote follow stream. */
type Row = Record<string, unknown>
const row = (value: unknown): Row | undefined => typeof value === 'object' && value !== null ? value as Row : undefined
export function installRunGuards(session: object, transport: typeof fetch = fetch): () => void {
  const turns = new Map<string, number>()
  const originals = new Map<string, PropertyDescriptor>()
  const observe = (id: string, value: unknown) => {
    const frame = row(value)
    const events = frame?.type === 'snapshot' && Array.isArray(frame.records) ? frame.records : [frame]
    for (const entry of events) {
      const event = row(row(entry)?.event)
      if (event?.type === 'turn/start' && typeof event.seq === 'number') turns.set(id, Math.max(turns.get(id) ?? -1, event.seq))
    }
  }
  for (const method of ['follow', 'prompt', 'cancel', 'updateQueue']) {
    const descriptor = Object.getOwnPropertyDescriptor(session, method)
    const getter = descriptor?.get?.bind(session)
    if (descriptor === undefined || getter === undefined) continue
    originals.set(method, descriptor)
    Object.defineProperty(session, method, { configurable: true, enumerable: true, get: () => {
      const upstream = getter() as (request: Row, signal?: AbortSignal) => unknown
      if (method === 'follow') return async function* (request: Row, signal?: AbortSignal) {
        const id = row(request.address)?.sessionId
        for await (const frame of upstream(request, signal) as AsyncIterable<unknown>) {
          if (typeof id === 'string') observe(id, frame)
          yield frame
        }
      }
      return (request: Row, signal?: AbortSignal) => {
        const guarded = method === 'cancel' || (method === 'prompt' && request.mode === 'steer') || (method === 'updateQueue' && row(request.action)?.kind === 'steer')
        if (!guarded) return upstream(request, signal)
        return (async () => {
          const response = await transport(`/api/session.${method}`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-edge-turn-seq': String(turns.get(String(request.sessionId)) ?? -1) },
            body: JSON.stringify({ type: 'client-request', method: `session.${method}`, rpcId: crypto.randomUUID(), payload: request }),
            ...signal === undefined ? {} : { signal },
          })
          if (!response.ok) return { ok: false, error: { code: 'session/busy', message: 'The observed run has ended. Refresh the session before retrying.', details: {} } }
          return (await response.json() as { result: unknown }).result
        })()
      }
    } })
  }
  return () => { for (const [method, descriptor] of originals) Object.defineProperty(session, method, descriptor) }
}
