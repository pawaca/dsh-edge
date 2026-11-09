/** One bounded Markdown response at a time, including a slow reader's body.
 * Reject excess demand before SQL/formatting instead of queueing more snapshots.
 */
import { requestDeadline } from './edge-deadline.ts'

export class MarkdownCopyBudget {
  private active = false

  async run(signal: AbortSignal, render: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    if (this.active) return new Response('Another Markdown copy is in progress. Retry shortly or use Download session logs.', {
      status: 429, headers: { 'retry-after': '1' },
    })
    signal.throwIfAborted()
    this.active = true
    const deadline = requestDeadline(30_000, signal)
    let handedOff = false
    let released = false
    let onAbort: (() => void) | undefined
    const release = () => {
      if (released) return
      released = true
      deadline[Symbol.dispose]()
      if (onAbort !== undefined) deadline.signal.removeEventListener('abort', onAbort)
      this.active = false
    }
    try {
      const response = await render(deadline.signal)
      deadline.signal.throwIfAborted()
      if (!response.ok || response.body === null) return response
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      let pending: Uint8Array | undefined
      let offset = 0
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          onAbort = () => {
            pending = undefined
            controller.error(deadline.signal.reason)
            void reader.cancel(deadline.signal.reason).catch(() => {})
            release()
          }
          deadline.signal.addEventListener('abort', onAbort, { once: true })
        },
        async pull(controller) {
          try {
            if (pending === undefined) {
              const chunk = await reader.read()
              if (released) return
              if (chunk.done) { controller.close(); release(); return }
              pending = chunk.value
              offset = 0
            }
            // Small chunks preserve downstream backpressure. A single enqueue
            // of the entire 4 MiB body would release admission too early.
            const end = Math.min(offset + 16 * 1024, pending.byteLength)
            controller.enqueue(pending.subarray(offset, end))
            offset = end
            if (offset === pending.byteLength) pending = undefined
          } catch (error) {
            if (!released) controller.error(error)
            pending = undefined
            release()
          }
        },
        async cancel(reason) {
          pending = undefined
          try { await reader.cancel(reason) } finally { release() }
        },
      }, { highWaterMark: 0 })
      handedOff = true
      return new Response(body, response)
    } finally {
      if (!handedOff) release()
    }
  }
}
