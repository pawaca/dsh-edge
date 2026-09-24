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

export class ContainerActivity {
  private inFlight = 0
  private lastActivity: number | undefined
  private stopping: Promise<void> | undefined

  constructor(
    private readonly sleepAfterMs = CONTAINER_SLEEP_AFTER_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Admit one command: wait out an in-flight idle stop (which would otherwise
   * destroy the container underneath it), then mark it running.
   */
  async admit(): Promise<() => void> {
    while (this.stopping !== undefined) await this.stopping
    return this.begin()
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
