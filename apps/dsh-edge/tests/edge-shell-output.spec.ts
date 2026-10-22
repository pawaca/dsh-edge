import { describe, expect, it } from 'vitest'
import { SHELL_OUTPUT_TAIL_BYTES, StreamCapture, type ShellSpillTarget } from '../src/edge-shell-output.ts'

/** A spill target that counts what it stores, optionally slowly. */
function countingTarget(delayEveryChunk = false) {
  const stored = { bytes: 0, chunks: 0, last: new Uint8Array(0) as Uint8Array, opened: 0 }
  const open = (): ShellSpillTarget => {
    stored.opened++
    return {
      path: '/workspace/.spill/test.txt',
      write: async (body) => {
        for await (const chunk of body) {
          stored.bytes += chunk.byteLength
          stored.chunks++
          stored.last = chunk
          // A microtask, not a timer: storage still lags the producer, without
          // hundreds of timer turns on a slow runner.
          if (delayEveryChunk) await Promise.resolve()
        }
      },
    }
  }
  return { stored, open }
}

function patterned(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index++) bytes[index] = 0x61 + ((index + seed) % 26)
  return bytes
}

describe('bounded stream capture', () => {
  it('keeps 20 MiB of output at a flat footprint: the tail inline, the rest streamed to the spill', async () => {
    const { stored, open } = countingTarget(true)
    const capture = new StreamCapture(open, { tailBytes: SHELL_OUTPUT_TAIL_BYTES, spillMaxBytes: 32 * 1024 * 1024 })
    const sizes = [1, 4_096, 65_537, 300_000, 17]
    let total = 0
    let peak = 0
    let last: Uint8Array = new Uint8Array(0)
    for (let index = 0; total < 20 * 1024 * 1024; index++) {
      const chunk = patterned(sizes[index % sizes.length]!, index)
      await capture.push(chunk)
      total += chunk.byteLength
      last = chunk
      peak = Math.max(peak, capture.retainedBytes)
    }
    const result = await capture.finish()
    expect(stored.opened).toBe(1)
    expect(stored.bytes).toBe(total)
    expect(peak).toBeLessThanOrEqual(SHELL_OUTPUT_TAIL_BYTES + 300_000)
    expect(result.truncated).toBe(true)
    expect(result.spillPath).toBe('/workspace/.spill/test.txt')
    expect(result.text.length).toBe(SHELL_OUTPUT_TAIL_BYTES)
    expect(result.text.endsWith(new TextDecoder().decode(last.subarray(-17)))).toBe(true)
  }, 30_000)

  it('queues a single large chunk in slices, never past the queue bound', async () => {
    let queuedPeak = 0
    let queued = 0
    let release!: () => void
    const reading = new Promise<void>(resolve => { release = resolve })
    const open = (): ShellSpillTarget => ({
      path: '/workspace/.spill/big.txt',
      write: async (body) => {
        await reading
        for await (const chunk of body) queued -= chunk.byteLength
      },
    })
    const capture = new StreamCapture(open, { tailBytes: SHELL_OUTPUT_TAIL_BYTES, spillMaxBytes: 32 * 1024 * 1024 })
    const original = Object.getOwnPropertyDescriptor(WritableStreamDefaultWriter.prototype, 'write')!
    const spy = { write: original.value as (this: WritableStreamDefaultWriter, chunk?: unknown) => Promise<void> }
    WritableStreamDefaultWriter.prototype.write = function (this: WritableStreamDefaultWriter, part?: unknown) {
      queued += (part as Uint8Array).byteLength
      queuedPeak = Math.max(queuedPeak, queued)
      return spy.write.call(this, part)
    }
    try {
      // The lightweight shell's whole 8 MiB stdout arrives as one event.
      const pushing = capture.push(new Uint8Array(8 * 1024 * 1024).fill(0x65))
      await new Promise(resolve => setTimeout(resolve, 10))
      // Storage has not read anything yet: at most the queue bound plus one slice is waiting.
      expect(queuedPeak).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024)
      release()
      await pushing
      const result = await capture.finish()
      expect(result.spillPath).toBe('/workspace/.spill/big.txt')
      expect(capture.retainedBytes).toBe(SHELL_OUTPUT_TAIL_BYTES)
    } finally {
      Object.defineProperty(WritableStreamDefaultWriter.prototype, 'write', original)
    }
  })

  it('opens no spill for output that fits the tail', async () => {
    const { stored, open } = countingTarget()
    const capture = new StreamCapture(open, { tailBytes: 10, spillMaxBytes: 100 })
    await capture.push(new TextEncoder().encode('0123456789'))
    expect(await capture.finish()).toEqual({ text: '0123456789', truncated: false })
    expect(stored.opened).toBe(0)
  })

  it('keeps only the start of a stream past the spill cap and says so', async () => {
    const { stored, open } = countingTarget()
    const capture = new StreamCapture(open, { tailBytes: 4, spillMaxBytes: 10 })
    for (const text of ['abcdef', 'ghijkl', 'mnop']) await capture.push(new TextEncoder().encode(text))
    const result = await capture.finish()
    expect(stored.bytes).toBe(10)
    expect(result).toEqual({ text: 'mnop', truncated: true, spillPath: '/workspace/.spill/test.txt', spillPartial: true })
  })

  it('drops a character the tail cut through, keeping the spill of what was read', async () => {
    const { stored, open } = countingTarget()
    const capture = new StreamCapture(open, { tailBytes: 4, spillMaxBytes: 100 })
    // '新' is three bytes; a four-byte tail of 'a新新' starts inside the first one.
    await capture.push(new TextEncoder().encode('a新新'))
    const result = await capture.finish()
    expect(result.text).toBe('新')
    // What was written stays reachable rather than orphaned in storage.
    expect(result.spillPath).toBe('/workspace/.spill/test.txt')
    expect(stored.bytes).toBe(7)
  })
})
