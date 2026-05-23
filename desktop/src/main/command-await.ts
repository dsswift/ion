/**
 * Promise-wrapper around `engine_command_result` events.
 *
 * The unified prompt pipeline (prompt-pipeline.ts) needs to dispatch a slash
 * command to the engine and then react to the engine's response synchronously:
 * success → done, "unknown_command" → fall through to `.md` expansion. The
 * engine bridge emits these events asynchronously, so we register a one-shot
 * listener filtered on the (key, command) pair and resolve when it fires.
 *
 * Two reliability properties we care about:
 *
 *   1. **No duplicate listeners.** Multiple pending slashes against the same
 *      session key are rare in practice (the renderer disables the send
 *      button while a tab is .connecting), but iOS can pipeline. We keep a
 *      per-key FIFO queue so the right awaiter resolves with the right
 *      event, in order.
 *
 *   2. **Timeout safety.** If the engine crashes between dispatch and
 *      result, we must not leak a hanging promise. The default timeout
 *      (5s) is generous enough for any sensible command but small enough
 *      to surface a real bug rather than block the pipeline.
 *
 * The result includes the full event so callers can inspect EventMessage,
 * Command, and CommandError fields. The shape mirrors `EngineCommandResult`
 * in the Go EngineEvent — extracted here so callers don't need to import
 * the wider EngineEvent union.
 */

import { EventEmitter } from 'events'
import { log as _log } from './logger'
import { engineBridge } from './state'

function log(msg: string): void {
  _log('main', msg)
}

/** Result of awaiting an engine_command_result event. */
export interface CommandResult {
  command: string
  message: string
  /** Empty for success. "unknown_command" or an extension error string otherwise. */
  commandError: string
}

/** Per-key queue entry: a waiter that wants the next result for `command`. */
interface Waiter {
  command: string
  resolve: (result: CommandResult) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Map of session-key → FIFO queue of waiters. We never index by command name
 * directly because two pipelines could race against the same key with
 * different commands; FIFO ordering by dispatch time is the only reliable
 * pairing strategy short of an explicit correlation id (the engine wire
 * doesn't carry one for command_result today).
 */
const waiters = new Map<string, Waiter[]>()

/** Default timeout in ms. Tunable per-call. 5s is well above the engine's
 *  typical dispatch latency (sub-millisecond for built-ins, ~20ms for
 *  extension RPC) and well below any sensible UX timeout. */
const DEFAULT_TIMEOUT_MS = 5_000

let listenerAttached = false

/**
 * Attach the global event listener exactly once. Idempotent — calling repeatedly
 * is a no-op after the first attachment. We attach lazily on the first
 * awaitCommandResult call rather than at module load because some tests
 * import this module without an engineBridge mock; lazy attachment lets
 * those tests still typecheck and import cleanly.
 */
function ensureListener(): void {
  if (listenerAttached) return
  listenerAttached = true
  engineBridge.on('event', (key: string, event: { type?: string; command?: string; message?: string; commandError?: string }) => {
    if (event.type !== 'engine_command_result') return
    const queue = waiters.get(key)
    if (!queue || queue.length === 0) {
      // Result fired with no waiter — log so we can spot orphan results,
      // but don't treat as an error. Built-ins that the renderer dispatched
      // directly (legacy engineCommand IPC path) also produce results we
      // don't await.
      log(`awaitCommandResult: orphan engine_command_result key=${key} command=${event.command ?? ''} err=${event.commandError ?? ''}`)
      return
    }
    // FIFO: the oldest waiter is paired with this result. We do not match
    // by command name on purpose — the engine echoes the command name back,
    // but the renderer-initiated dispatch path (legacy) emits results that
    // could otherwise be mis-paired with a pipeline waiter. FIFO is the
    // honest contract: "the next result is your result."
    const w = queue.shift()!
    if (queue.length === 0) {
      waiters.delete(key)
    }
    clearTimeout(w.timer)
    const result: CommandResult = {
      command: event.command ?? w.command,
      message: event.message ?? '',
      commandError: event.commandError ?? '',
    }
    log(`awaitCommandResult: resolved key=${key} dispatchedCmd=${w.command} echoedCmd=${result.command} err=${result.commandError}`)
    w.resolve(result)
  })
  log('awaitCommandResult: global listener attached to engineBridge')
}

/**
 * Wait for the next `engine_command_result` event addressed to `key`.
 * Returns the result on success, or a synthetic timeout result if the engine
 * fails to respond within `timeoutMs`. The timeout result carries
 * `commandError: 'timeout'` so the caller can react (fall back to `.md`
 * expansion, surface an error, etc.) without distinguishing wire-level
 * timeout from engine-reported unknown_command.
 *
 * The `command` argument is recorded for diagnostic logging and as the
 * fallback in the resolved result when the engine's echoed Command field
 * is somehow empty (defensive — should never happen with the current
 * engine code).
 */
export function awaitCommandResult(key: string, command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  ensureListener()
  return new Promise<CommandResult>((resolve) => {
    const queue = waiters.get(key) ?? []
    const timer = setTimeout(() => {
      // Remove ourselves from the queue (we may not be at the head if a
      // later dispatch raced ahead) and synthesise a timeout result.
      const q = waiters.get(key)
      if (q) {
        const idx = q.indexOf(entry)
        if (idx >= 0) q.splice(idx, 1)
        if (q.length === 0) waiters.delete(key)
      }
      log(`awaitCommandResult: TIMEOUT key=${key} command=${command} after=${timeoutMs}ms`)
      resolve({ command, message: 'timeout waiting for engine_command_result', commandError: 'timeout' })
    }, timeoutMs)
    const entry: Waiter = { command, resolve, timer }
    queue.push(entry)
    waiters.set(key, queue)
    log(`awaitCommandResult: registered key=${key} command=${command} queueDepth=${queue.length}`)
  })
}

/**
 * Test-only: drain all queues without resolving. Lets unit tests reset state
 * between cases without leaking timers. Not exported via index — callers
 * must import this name directly to make the intent obvious in tests.
 */
export function _resetAwaitersForTests(): void {
  for (const queue of waiters.values()) {
    for (const w of queue) clearTimeout(w.timer)
  }
  waiters.clear()
  listenerAttached = false
  // Note: we can't easily detach the listener since `engineBridge.on` doesn't
  // expose a handle here. Tests that need a clean listener bind should reset
  // the engineBridge mock too. The flag toggle is enough for re-attachment
  // logic to work correctly in the next test.
}

// Re-export the EventEmitter import so the file doesn't break if a future
// refactor adds a typed-emitter wrapper. Keeps the surface area predictable.
export type { EventEmitter }
