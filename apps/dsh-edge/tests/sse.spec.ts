import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { createLiveSessionEventStream, encodeSessionEvent } from '../src/sse.ts'

const event: SessionEvent = {
  type: 'session/title',
  seq: SessionSeq(0),
  time: 1,
  data: {
    title: 'Stream contract',
    messageSeqs: [],
    source: { kind: 'user' },
  },
}

describe('dsh-edge live event stream', () => {
  it('keeps ignorable event names inside one SSE field', () => {
    const unsafeEvent = {
      type: 'future/plugin\r\nid: injected\n\n',
      seq: 1,
      time: 2,
      data: { value: true },
      ignorable: true,
    } as SessionEvent

    const encoded = new TextDecoder().decode(encodeSessionEvent(unsafeEvent))

    expect(encoded).toContain('event: future/plugin%0D%0Aid: injected%0A%0A\n')
    expect(encoded).not.toContain('\nid: injected\n')
    expect(encoded.match(/\n\n/g)).toHaveLength(1)
  })

  it('encodes events and closes after a successful producer', async () => {
    const onFailure = vi.fn()
    const { stream, completion } = createLiveSessionEventStream(async (publish) => {
      publish(event)
    }, onFailure)

    await expect(new Response(stream).text()).resolves.toContain('event: session/title')
    await expect(completion).resolves.toBeUndefined()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('errors the client stream when the Edge producer fails', async () => {
    const failure = new Error(`storage transport failed for ${SessionId('session-a')}`)
    const onFailure = vi.fn()
    const { stream, completion } = createLiveSessionEventStream(
      () => Promise.reject(failure),
      onFailure,
    )

    await expect(new Response(stream).text()).rejects.toThrow('dsh-edge turn transport failed.')
    await expect(completion).resolves.toBeUndefined()
    expect(onFailure).toHaveBeenCalledWith(failure)
  })

  it('disconnects a slow client at the byte queue limit while the producer finishes', async () => {
    const onFailure = vi.fn()
    let producerFinished = false
    const largeEvent = {
      ...event,
      data: {
        ...event.data,
        title: 'x'.repeat(600_000),
      },
    } satisfies SessionEvent
    const { stream, completion } = createLiveSessionEventStream(async (publish) => {
      publish(largeEvent)
      publish({ ...largeEvent, seq: SessionSeq(1) })
      producerFinished = true
    }, onFailure)

    await expect(completion).resolves.toBeUndefined()
    expect(producerFinished).toBe(true)
    await expect(new Response(stream).text()).rejects.toThrow(
      'dsh-edge event stream client is too slow.',
    )
    expect(onFailure).not.toHaveBeenCalled()
  })
})
