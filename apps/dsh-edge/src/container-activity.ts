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

  constructor(
    private readonly sleepAfterMs = CONTAINER_SLEEP_AFTER_MS,
    private readonly now: () => number = Date.now,
  ) {}

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
