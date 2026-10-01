/**
 * early-error-guard -- keeps a socket's immediate failure from crashing the
 * main process before anything is listening for it.
 *
 * `EnvironmentConnection.attempt()` (`environment-connection.ts`) attaches its
 * `once('error', ...)` only after `ConnectionTarget.open()` resolves, because
 * picking the route and deriving the credential are async. The socket itself
 * is dialed synchronously, inside that same `open()` call, so a connection
 * that fails right away (a TLS reset, a refused connect) can emit 'error'
 * before `attempt()`'s listener is attached. Node's EventEmitter throws an
 * `error` event that has no listener, which without this guard surfaces as
 * an uncaught exception that crashes the whole desktop app.
 *
 * This buffers exactly one such early error and replays it to whichever
 * `once('error', ...)` attaches next, instead of losing it or throwing it.
 */
import type { EventEmitter } from 'events'
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-early-error-guard', msg, fields)
}

type AnyListener = (...args: unknown[]) => void

/** Installs the guard on `emitter` (a `ws` WebSocket or `SealedStudioSocket`) and returns it for chaining. `peer` names the far end in logs, never a secret. */
export function guardEarlyError<T extends EventEmitter>(emitter: T, peer: string): T {
  const untyped = emitter as unknown as EventEmitter & { once: (event: string | symbol, listener: AnyListener) => EventEmitter }
  let pendingError: Error | null = null
  // Keeps `listenerCount('error')` at 1 or more for the entire lifetime of
  // `emitter`, so Node's EventEmitter never treats a future `emit('error', …)`
  // as unhandled. When this fires before anything else is listening, it
  // holds the error instead of letting it vanish silently.
  untyped.on('error', (err: Error) => {
    if (untyped.listenerCount('error') > 1) return
    warn('socket errored before anything was listening; holding it for the next listener', { peer, error: err.message })
    pendingError = err
  })
  const realOnce = untyped.once.bind(untyped)
  untyped.once = (event: string | symbol, listener: AnyListener) => {
    if (event === 'error' && pendingError) {
      const err = pendingError
      pendingError = null
      process.nextTick(() => listener(err))
      return untyped
    }
    return realOnce(event, listener)
  }
  return emitter
}
