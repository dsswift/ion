/**
 * socket-liveness -- finds a WebSocket that looks open but is dead.
 *
 * A network change (another Wi-Fi, a VPN coming up, sleep) strands a TCP
 * connection: the far end stops hearing from this side and drops it, while
 * this side, sending nothing on an idle socket, never sees a close. Only a
 * ping this side sends itself finds that. One ping goes out per interval; a
 * ping still unanswered at the next tick means the socket is dead, so a dead
 * socket is found within two intervals and terminated, which fires the
 * socket's ordinary close handling.
 */

/** The part of a `ws` WebSocket this needs. */
export interface PingableSocket {
  readonly readyState: number
  ping(): void
  terminate(): void
  on(event: 'pong', listener: () => void): unknown
  removeListener(event: 'pong', listener: () => void): unknown
}

/** `WebSocket.OPEN` in `ws` and in the WHATWG API. */
const OPEN = 1

/** Default ping interval for a socket to a server or relay. */
export const SOCKET_LIVENESS_INTERVAL_MS = 15_000

export interface SocketLivenessOptions {
  intervalMs?: number
  /** Called once when the socket is found dead, just before it is terminated. For the caller's log line. */
  onDead: () => void
  /** Called when a ping throws. The next tick still judges the socket. */
  onPingError?: (err: unknown) => void
}

/**
 * Starts the check on an open socket. Returns the stop function; the check
 * also stops on its own once the socket leaves the open state.
 */
export function watchSocketLiveness(socket: PingableSocket, options: SocketLivenessOptions): () => void {
  let awaitingPong = false
  const onPong = (): void => { awaitingPong = false }
  socket.on('pong', onPong)
  const stop = (): void => {
    clearInterval(timer)
    socket.removeListener('pong', onPong)
  }
  const timer = setInterval(() => {
    if (socket.readyState !== OPEN) {
      stop()
      return
    }
    if (awaitingPong) {
      stop()
      options.onDead()
      socket.terminate()
      return
    }
    awaitingPong = true
    try {
      socket.ping()
    } catch (err) {
      options.onPingError?.(err)
    }
  }, options.intervalMs ?? SOCKET_LIVENESS_INTERVAL_MS)
  // A liveness check never holds a process open on its own.
  if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
  return stop
}
