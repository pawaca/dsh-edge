/** Batch event delivery behind the matching durable persistence flush. */

interface DurableEventDeliveryQueueConfig<T> {
  maxDelayMs: number
  flush: () => unknown
  deliver: (items: readonly T[]) => void | Promise<void>
  onError?: (error: unknown) => void
  onIdle?: () => void
}

/**
 * Preserve durable-before-visible delivery without defeating persistence's
 * short write-behind window with one explicit flush per streamed event.
 */
export class DurableEventDeliveryQueue<T> {
  private readonly pending: T[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = Promise.resolve()
  private failed = false
  private failure: unknown
  private acceptedEnqueues = 0

  constructor(private readonly config: DurableEventDeliveryQueueConfig<T>) {}

  /** Monotonic marker used to prove that a drained subscription snapshot stayed quiet. */
  get revision(): number {
    return this.acceptedEnqueues
  }

  enqueue(item: T): void {
    if (this.failed) return
    this.acceptedEnqueues += 1
    this.pending.push(item)
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.schedulePending()
    }, this.config.maxDelayMs)
  }

  async drain(): Promise<void> {
    while (true) {
      if (this.timer !== undefined) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
      this.schedulePending()
      const running = this.running
      await running
      if (this.failed) throw this.failure
      if (running === this.running && this.pending.length === 0 && this.timer === undefined) return
    }
  }

  private schedulePending(): void {
    if (this.failed || this.pending.length === 0) return
    const batch = this.pending.splice(0)
    const work = this.running.then(async () => {
      if (this.failed) return
      await this.config.flush()
      await this.config.deliver(batch)
    })
    const running = work.catch((error: unknown) => {
      this.failed = true
      this.failure = error
      this.pending.length = 0
      try {
        this.config.onError?.(error)
      } catch {
        // Delivery failures must remain observable through drain().
      }
    })
    this.running = running
    void running.then(() => {
      if (!this.failed && this.running === running
        && this.pending.length === 0 && this.timer === undefined) {
        this.config.onIdle?.()
      }
    })
  }
}
