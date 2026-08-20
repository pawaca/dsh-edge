/** Server-sent-event encoding for canonical DSH SessionEvents. */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

const encoder = new TextEncoder()
const MAX_LIVE_STREAM_QUEUED_BYTES = 1_048_576

/** Encode one upstream event without translating its envelope or payload. */
export function encodeSessionEvent(event: SessionEvent): Uint8Array {
  const eventType = encodeEventType(event.type)
  return encoder.encode(
    `id: ${event.seq}\nevent: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/** Keep canonical names stable while making arbitrary ignorable names one SSE field. */
function encodeEventType(type: string): string {
  return type
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
}

/** Headers used by live and finite replay streams. */
export function edgeEventStreamHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra)
  headers.set('cache-control', 'no-cache, no-transform')
  headers.set('content-type', 'text/event-stream; charset=utf-8')
  headers.set('x-accel-buffering', 'no')
  return headers
}

export interface LiveSessionEventStream {
  readonly stream: ReadableStream<Uint8Array>
  /** Settles after the producer closes or errors the client-visible stream. */
  readonly completion: Promise<void>
}

/** Run an event producer whose escaped failures become client-visible stream errors. */
export function createLiveSessionEventStream(
  run: (publish: (event: SessionEvent) => void) => Promise<void>,
  onFailure: (error: unknown) => void,
): LiveSessionEventStream {
  let connected = true
  let settle!: () => void
  const completion = new Promise<void>((resolve) => { settle = resolve })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void Promise.resolve().then(async () => run((event) => {
        if (!connected) return
        try {
          const chunk = encodeSessionEvent(event)
          if (controller.desiredSize === null || controller.desiredSize < chunk.byteLength) {
            connected = false
            controller.error(new Error('dsh-edge event stream client is too slow.'))
            return
          }
          controller.enqueue(chunk)
        } catch {
          connected = false
        }
      })).then(() => {
        if (connected) {
          try {
            controller.close()
          } catch {
            connected = false
          }
        }
      }, (error: unknown) => {
        onFailure(error)
        if (connected) {
          connected = false
          controller.error(new Error('dsh-edge turn transport failed.'))
        }
      }).finally(settle)
    },
    cancel() {
      connected = false
    },
  }, {
    highWaterMark: MAX_LIVE_STREAM_QUEUED_BYTES,
    size: chunk => chunk.byteLength,
  })
  return { stream, completion }
}
