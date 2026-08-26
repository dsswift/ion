/**
 * Per-browser-instance operation serialization.
 *
 * Two agents (or an agent and a mid-flight emulation change) must never
 * interleave clicks, navigation, or form input on ONE page: the second action
 * would land on a DOM the first has already begun changing, and the failure
 * looks like a flaky page rather than a race. So every operation on a browser
 * instance runs to completion before the next one starts.
 *
 * Serialization is per instance, not global. Different conversations drive
 * different pages and must stay parallel — a long full-page screenshot in one
 * conversation cannot be allowed to stall another conversation's agent.
 */
import { debug as _debug, warn as _warn } from '../logger'

const TAG = 'studio-playwright'

/** Thrown to queued work when its browser tab goes away before it can run. */
export class QueueCancelledError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'QueueCancelledError'
  }
}

interface QueueEntry {
  run(): Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
  label: string
}

class InstanceQueue {
  private readonly pending: QueueEntry[] = []
  private running = false
  private cancelled: string | null = null

  async enqueue<T>(label: string, run: () => Promise<T>): Promise<T> {
    if (this.cancelled) throw new QueueCancelledError(this.cancelled)
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        label,
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      void this.drain()
    })
  }

  /** Fail everything queued and refuse later work with the same reason. */
  cancel(reason: string): void {
    this.cancelled = reason
    const waiting = this.pending.splice(0, this.pending.length)
    for (const entry of waiting) entry.reject(new QueueCancelledError(reason))
    if (waiting.length > 0) {
      _warn(TAG, 'browser operations cancelled', { reason, cancelled_count: waiting.length })
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const entry = this.pending.shift()
        if (!entry) break
        const started = Date.now()
        try {
          entry.resolve(await entry.run())
        } catch (err) {
          entry.reject(err)
        } finally {
          _debug(TAG, 'browser operation finished', { operation: entry.label, duration_ms: Date.now() - started, queue_depth: this.pending.length })
        }
      }
    } finally {
      this.running = false
    }
  }
}

/** Queues keyed by browser instance. */
export class OperationQueues {
  private readonly queues = new Map<string, InstanceQueue>()

  run<T>(instanceId: string, label: string, work: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(instanceId)
    if (!queue) {
      queue = new InstanceQueue()
      this.queues.set(instanceId, queue)
    }
    return queue.enqueue(label, work)
  }

  /** Called when a tab closes: queued work fails visibly instead of hanging. */
  cancel(instanceId: string, reason: string): void {
    const queue = this.queues.get(instanceId)
    if (!queue) return
    queue.cancel(reason)
    this.queues.delete(instanceId)
  }
}
