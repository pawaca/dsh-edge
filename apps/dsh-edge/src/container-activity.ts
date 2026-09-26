/**
 * Idle shutdown for a Container attached to the owning Durable Object.
 *
 * The raw `ctx.container` API never stops a container on its own, so the
 * Durable Object tracks command activity in memory and stops an idle
 * container from its alarm. Nothing is persisted per command: after an
 * eviction the tracker starts empty, which reads as idle.
 */

/** How long a container stays up after its last command settles. */
export const CONTAINER_SLEEP_AFTER_MS = 10 * 60_000

/**
 * Commands that may run in the container at once. Every session and subagent
 * shares one small container; later commands wait for a slot.
 */
export const CONTAINER_MAX_CONCURRENT_COMMANDS = 2

export class ContainerActivity {
  private inFlight = 0
  private lastActivity: number | undefined
  private stopping: Promise<void> | undefined
  private readonly waiters: Array<() => void> = []

  constructor(
    private readonly sleepAfterMs = CONTAINER_SLEEP_AFTER_MS,
    private readonly now: () => number = Date.now,
    private readonly maxConcurrent = CONTAINER_MAX_CONCURRENT_COMMANDS,
  ) {}

  /**
   * Admit one command: wait out an in-flight idle stop (which would otherwise
   * destroy the container underneath it) and for a free slot, then mark it
   * running. Reports how long the command waited.
   */
  async admit(signal?: AbortSignal): Promise<{ release: () => void; queuedMs: number }> {
    const started = this.now()
    while (this.stopping !== undefined || this.inFlight >= this.maxConcurrent) {
      signal?.throwIfAborted()
      if (this.stopping !== undefined) {
        await untilAborted(this.stopping, signal)
        continue
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }
        const abort = () => {
          const index = this.waiters.indexOf(wake)
          if (index !== -1) this.waiters.splice(index, 1)
          reject(signal!.reason)
        }
        this.waiters.push(wake)
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    // Cancelled between being woken and resuming: pass the free slot on.
    if (signal?.aborted === true) {
      this.waiters.shift()?.()
      signal.throwIfAborted()
    }
    return { release: this.begin(), queuedMs: this.now() - started }
  }

  /** Mark one command running; the returned release is idempotent. */
  begin(): () => void {
    this.inFlight += 1
    this.lastActivity = this.now()
    let released = false
    return () => {
      if (released) return
      released = true
      this.inFlight -= 1
      this.lastActivity = this.now()
      this.waiters.shift()?.()
    }
  }

  /**
   * Stop the container with `destroy` when idle. A failed stop restarts the
   * idle window so the next attempt is one window out, not an immediate retry.
   */
  async stopIfIdle(destroy: () => Promise<void>): Promise<'stopped' | 'busy' | 'failed'> {
    if (!this.idle() || this.stopping !== undefined) return 'busy'
    let outcome: 'stopped' | 'failed' = 'stopped'
    const stopping = destroy().catch((error: unknown) => {
      outcome = 'failed'
      this.lastActivity = this.now()
      console.error('dsh-edge idle container stop failed.', error)
    })
    this.stopping = stopping
    try {
      await stopping
    } finally {
      this.stopping = undefined
    }
    return outcome
  }

  /** The earliest time an idle check can stop the container. */
  deadline(): number {
    const from = this.inFlight > 0 ? this.now() : this.lastActivity ?? this.now()
    return from + this.sleepAfterMs
  }

  /** Whether no command is running and the last one settled long enough ago. */
  idle(): boolean {
    return this.inFlight === 0
      && (this.lastActivity === undefined || this.now() >= this.lastActivity + this.sleepAfterMs)
  }
}

/** Wait for `promise`, rejecting early with the signal's reason when it aborts. */
function untilAborted(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return promise
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
