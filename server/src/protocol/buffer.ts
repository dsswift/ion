/**
 * BoundedQueue — the per-connection send-buffer cap (manifest contract C3,
 * Functional Requirements: "Per-connection send buffer cap (default 8 MB);
 * overflow -> studio_close{slow_client}").
 *
 * A Studio connection can fall behind the server (a slow network, a paused
 * tab, a client stuck rendering a huge normalized-event backlog). Node's
 * `ws` already queues unsent frames internally (`WebSocket.bufferedAmount`),
 * but that number resets to 0 only once every queued frame actually leaves
 * the socket — it gives no early signal while the client is merely slow, and
 * it is not observable until AFTER `send()` has already accepted the data.
 * This tracks bytes accepted-but-not-yet-flushed ourselves so a connection
 * can be closed the moment it crosses the cap, before the process's own
 * memory grows unbounded queuing frames for a client that will never drain
 * them.
 */
export const DEFAULT_BUFFER_CAP_BYTES = 8 * 1024 * 1024

export class BoundedQueue {
  private queuedBytes = 0

  constructor(private readonly capBytes: number = DEFAULT_BUFFER_CAP_BYTES) {}

  /** Bytes currently considered "in flight" (accepted, not yet confirmed flushed). */
  get size(): number {
    return this.queuedBytes
  }

  get cap(): number {
    return this.capBytes
  }

  /**
   * Record `n` bytes as queued. Returns `true` when this push crosses the
   * cap — the caller must close the connection with `slow_client` and
   * should not push again (the queue does not self-reset on overflow; a
   * fresh connection gets a fresh queue on reconnect).
   */
  push(n: number): boolean {
    this.queuedBytes += n
    return this.queuedBytes > this.capBytes
  }

  /** Record `n` bytes as flushed (the underlying socket confirmed the write). */
  drain(n: number): void {
    this.queuedBytes = Math.max(0, this.queuedBytes - n)
  }

  reset(): void {
    this.queuedBytes = 0
  }
}
