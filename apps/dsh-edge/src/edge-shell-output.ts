/**
 * Bounded capture of one command's output stream, as upstream `bash-local`
 * keeps it: the last {@link SHELL_OUTPUT_TAIL_BYTES} bytes for the model, and
 * the complete stream in a spill file whose path the result reports, while the
 * command keeps running.
 *
 * Output is held in memory only up to the tail size. Below it nothing is
 * written anywhere; on the first byte past it the held prefix and every later
 * chunk stream to the spill file through a writer whose queue is bounded, and
 * the caller awaits {@link StreamCapture.push} before reading the next chunk,
 * so a fast producer waits for storage instead of growing memory. Past
 * {@link SHELL_SPILL_MAX_BYTES} the spill stops (the file keeps its first
 * bytes) and only the tail moves on.
 */

/** Bytes of each stream the model sees: upstream bash-local's `maxOutputBytes` default. */
export const SHELL_OUTPUT_TAIL_BYTES = 64_000
/**
 * Bytes of each stream a spill file keeps. Upstream's default is 64 MiB; the
 * Edge keeps less because each 512 KiB costs about five Durable Object rows
 * written and the workspace VFS never frees a deleted file's bytes (#358).
 */
export const SHELL_SPILL_MAX_BYTES = 16 * 1024 * 1024
/** Bytes the spill writer may queue before `push` waits for storage. */
const SPILL_QUEUE_BYTES = 1024 * 1024
/** Bytes of one queued spill write. */
const SPILL_SLICE_BYTES = 64 * 1024

export type ShellStream = 'stdout' | 'stderr'

/** Where a stream's complete output goes once it passes the tail size. */
export interface ShellSpillTarget {
  readonly path: string
  /** Consume the spill bytes; resolves when they are stored. */
  write(body: ReadableStream<Uint8Array>): Promise<void>
}

/** One stream's captured output. */
export interface CapturedStream {
  /** The whole stream, or its last {@link SHELL_OUTPUT_TAIL_BYTES} bytes when `truncated`. */
  readonly text: string
  readonly truncated: boolean
  /** The complete stream (up to {@link SHELL_SPILL_MAX_BYTES}); absent when it could not be saved. */
  readonly spillPath?: string
  /** The stream passed {@link SHELL_SPILL_MAX_BYTES}, so the spill holds only its start. */
  readonly spillPartial?: boolean
  /** The spill was still being written when the result was taken, so it may be incomplete. */
  readonly spillPending?: boolean
}

export interface StreamCaptureLimits {
  readonly tailBytes: number
  readonly spillMaxBytes: number
}

const DEFAULT_LIMITS: StreamCaptureLimits = { tailBytes: SHELL_OUTPUT_TAIL_BYTES, spillMaxBytes: SHELL_SPILL_MAX_BYTES }

export class StreamCapture {
  private held: Uint8Array[] = []
  private heldBytes = 0
  private overflowed = false
  private spill: { writer: WritableStreamDefaultWriter<Uint8Array>; stored: Promise<void>; path: string } | undefined
  private spilledBytes = 0
  private spillFailed = false
  private spillPartial = false

  constructor(
    private readonly openSpill: () => ShellSpillTarget,
    private readonly limits: StreamCaptureLimits = DEFAULT_LIMITS,
  ) {}

  /** Bytes this capture holds in memory now (the tail, or the prefix before it). */
  get retainedBytes(): number {
    return this.heldBytes
  }

  /** Take one chunk; resolves once the spill writer can accept more. */
  async push(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return
    if (!this.overflowed && this.heldBytes + chunk.byteLength <= this.limits.tailBytes) {
      // Copy: a chunk can be a view of a much larger buffer.
      this.held.push(chunk.slice())
      this.heldBytes += chunk.byteLength
      return
    }
    if (!this.overflowed) {
      this.overflowed = true
      this.startSpill()
      for (const prefix of this.held) await this.write(prefix)
    }
    // The tail takes the chunk before its spill write waits for storage, so a
    // result taken while that write is pending still ends with it. Only the
    // part that can still be in the tail is copied.
    const keep = chunk.byteLength > this.limits.tailBytes
      ? chunk.slice(chunk.byteLength - this.limits.tailBytes)
      : chunk.slice()
    this.held.push(keep)
    this.heldBytes += keep.byteLength
    this.trimTail()
    await this.write(chunk)
  }

  /**
   * Close the spill and return the stream. A command that stops early (or is
   * no longer waited for) keeps the spill of what was read: its chunks are
   * already stored, and the workspace VFS would never free them unreachable
   * (#358). Only a spill whose storage failed is abandoned. With `wait`
   * false the spill closes in the background and its path is reported as
   * soon as no failure is known.
   */
  async finish(options: { wait?: boolean } = {}): Promise<CapturedStream> {
    let spillPath: string | undefined
    let pending = false
    if (this.spill !== undefined) {
      // Started once; a later call (no longer waiting) reuses it.
      const settling = this.settling ??= this.settle(this.spill)
      if (options.wait !== false) await settling
      if (!this.spillFailed) spillPath = this.spill.path
      pending = !this.settled
    }
    const bytes = concat(this.held, this.heldBytes)
    return {
      text: decodeTail(bytes, this.overflowed),
      truncated: this.overflowed,
      ...spillPath === undefined ? {} : { spillPath },
      ...spillPath !== undefined && this.spillPartial ? { spillPartial: true } : {},
      ...spillPath !== undefined && pending ? { spillPending: true } : {},
    }
  }

  private settling: Promise<void> | undefined
  private settled = false

  private async settle({ writer, stored }: NonNullable<StreamCapture['spill']>): Promise<void> {
    try {
      if (this.spillFailed) await writer.abort(new Error('command output spill failed'))
      else await writer.close()
      await stored
    } catch {
      this.spillFailed = true
    } finally {
      this.settled = true
    }
  }

  private startSpill(): void {
    let target: ShellSpillTarget
    try {
      target = this.openSpill()
    } catch {
      this.spillFailed = true
      return
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(
      undefined,
      new ByteLengthQueuingStrategy({ highWaterMark: SPILL_QUEUE_BYTES }),
    )
    const writer = writable.getWriter()
    const stored = target.write(readable)
    // A storage failure ends the spill; the tail and the command go on.
    stored.catch(() => { this.spillFailed = true })
    this.spill = { writer, stored, path: target.path }
  }

  /**
   * Queue a chunk in {@link SPILL_SLICE_BYTES} copies, waiting for the queue
   * before each: a large chunk (the lightweight shell emits a stream as one
   * event) never sits in the queue whole, and no queued slice keeps the
   * chunk's buffer alive.
   */
  private async write(chunk: Uint8Array): Promise<void> {
    const spill = this.spill
    if (spill === undefined || this.spillFailed) return
    // Past the cap the file keeps its first bytes; the tail still moves on.
    const room = this.limits.spillMaxBytes - this.spilledBytes
    if (chunk.byteLength > room) this.spillPartial = true
    const end = Math.min(chunk.byteLength, Math.max(0, room))
    for (let offset = 0; offset < end; offset += SPILL_SLICE_BYTES) {
      const part = chunk.slice(offset, Math.min(end, offset + SPILL_SLICE_BYTES))
      try {
        await spill.writer.ready
        void spill.writer.write(part).catch(() => { this.spillFailed = true })
        this.spilledBytes += part.byteLength
      } catch {
        this.spillFailed = true
        return
      }
      if (this.spillFailed) return
    }
  }

  /** Drop whole chunks from the front while the rest still covers the tail. */
  private trimTail(): void {
    while (this.held.length > 1 && this.heldBytes - this.held[0]!.byteLength >= this.limits.tailBytes) {
      this.heldBytes -= this.held.shift()!.byteLength
    }
    const excess = this.heldBytes - this.limits.tailBytes
    if (excess > 0) {
      this.held[0] = this.held[0]!.slice(excess)
      this.heldBytes -= excess
    }
  }
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Decode like a terminal: bytes that are not UTF-8 become U+FFFD instead of
 * failing. A tail cut can start inside a character, so its leading
 * continuation bytes are dropped; an incomplete sequence at the very end is
 * held back, as a streaming decoder does.
 */
function decodeTail(bytes: Uint8Array, cut: boolean): string {
  let start = 0
  if (cut) while (start < 3 && start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++
  return new TextDecoder('utf-8').decode(bytes.subarray(start), { stream: true })
}
