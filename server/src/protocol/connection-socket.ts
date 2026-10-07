/**
 * ConnectionSocket -- what `Connection` needs from the thing under it.
 *
 * A `ws` WebSocket satisfies this as-is; that is the local-socket and TCP
 * case. A relay channel (`protocol/relay-listener.ts`) satisfies it with a
 * small adapter that seals and opens E2E envelopes on either side of the
 * same calls. `Connection`, `listener.ts`'s per-connection wiring, and the
 * liveness sweep all see only this surface, so admitting a relay-fed client
 * is the same code path as admitting a TCP one.
 */

/**
 * What a transport knows about an inbound frame beyond its bytes. A sealed
 * socket reports the plaintext `traceparent` from the frame's envelope (a
 * relay with tracing on rewrote it with its own span), so the action the
 * frame carries can parent under the hop that delivered it. A plain `ws`
 * socket reports nothing here.
 */
export interface InboundFrameMeta {
  traceparent?: string
}

export interface ConnectionSocket {
  /** Sends one text or binary frame; `cb` fires once it left the socket (or with the error). */
  send(data: string | Buffer, cb?: (err?: Error) => void): void
  close(code?: number, reason?: string): void
  /** Drops the socket without a close handshake (a peer that stopped answering pings). */
  terminate(): void
  /** Liveness probe; the socket answers with a `pong` event. */
  ping(): void
  on(event: 'message', listener: (data: Buffer | string, isBinary: boolean, meta?: InboundFrameMeta) => void): this
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'pong', listener: () => void): this
}
