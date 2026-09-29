/**
 * A real `Connection` over an in-memory socket, for tests that need the
 * connection's own send semantics (answer pacing, the push cap) rather than
 * a stub of them. Every frame written is decoded into `sent`. By default a
 * write "leaves the socket" at once; with `holdWrites` each write waits in
 * `pending` until the test calls `flushNext()`, which is how a test stands in
 * for a link that has not carried the frame yet.
 */
import type { StudioFrame, Scope, StudioView } from '@ion/shared/studio-wire/types'
import { Connection } from '../connection'
import type { ConnectionSocket } from '../connection-socket'

export interface RecordingConnection {
  conn: Connection
  sent: StudioFrame[]
  /** Writes not yet reported as flushed (only with `holdWrites`). */
  pending: () => number
  /** Reports the oldest held write as flushed. */
  flushNext: () => void
}

export function recordingConnection(opts: { view?: StudioView; scopes?: Scope[]; holdWrites?: boolean } = {}): RecordingConnection {
  const sent: StudioFrame[] = []
  const held: Array<() => void> = []
  const socket = {
    send(data: string | Buffer, cb?: (err?: Error) => void): void {
      sent.push(JSON.parse(data.toString()) as StudioFrame)
      if (opts.holdWrites) held.push(() => cb?.())
      else cb?.()
    },
    close(): void {},
    terminate(): void {},
    ping(): void {},
    on(): ConnectionSocket { return socket },
  } as ConnectionSocket
  const conn = new Connection(socket, 'tcp')
  conn.view = opts.view ?? 'mirror'
  conn.scopes = opts.scopes ?? ['conversations:read']
  return {
    conn,
    sent,
    pending: () => held.length,
    flushNext: () => held.shift()?.(),
  }
}
