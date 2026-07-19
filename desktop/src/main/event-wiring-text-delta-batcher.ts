// Text-delta batcher — the single owner of the per-key engine_text_delta
// coalescing buffer and its flush discipline.
//
// Why this is its own module (extracted from event-wiring.ts):
//   The engine forwards assistant text as engine_text_delta at 50-200/sec per
//   key. We accumulate them here and flush at ~60fps (16ms) to cut Electron IPC
//   / relay serialization crossings. The load-bearing invariant is ORDERING:
//   any OTHER same-key envelope the desktop sends to iOS (a turn-boundary seal,
//   a /clear divider, a compaction marker) must be preceded on the FIFO wire by
//   the pending text for that key. Otherwise the later frame carries a lower
//   seq than text that chronologically preceded it, and iOS — which renders in
//   pure insertion order — draws the divider/marker ABOVE that text.
//
//   That discipline is only sound if there is exactly ONE buffer and ONE
//   `flushKeyDeltas`. The buffer used to be closure-local to
//   wireEngineBridgeEvents(), so the compaction-marker emitter in
//   event-wiring-remote.ts (a separate sessionPlane listener) had no way to
//   drain it and skipped the flush — a same-key ordering hole (RC-5). Hoisting
//   the batcher to module scope gives every same-key emitter access to the same
//   flush, closing the hole and making the discipline impossible to drift from.
//
// Wire-key (Key A) parsing: `tabId:instanceId`. The `|| null` is load-bearing —
// a plain conversation's wire key is bare (→ instanceId null); an
// extension-hosted instance's is compound (→ its instanceId). iOS depends on
// this null-vs-id distinction, so do NOT convert to parseSessionKey (which maps
// bare → 'main' and changes the forwarded wire shape).

import { state } from './state'

/** Per-key accumulator of un-flushed engine_text_delta text. */
const pendingTextDeltas = new Map<string, string>()
let deltaFlushTimer: ReturnType<typeof setInterval> | null = null

/** Split a wire key into the iOS-facing tabId + instanceId (null when bare). */
function splitWireKey(key: string): { tabId: string; instanceId: string | null } {
  return { tabId: key.split(':')[0], instanceId: key.split(':')[1] || null }
}

/**
 * The 16ms (~62.5Hz) flush: drain every key's buffered text to the remote
 * transport as one desktop_text_delta per key. Self-stops when the buffer is
 * empty so an idle stream doesn't wake the event loop forever; the next
 * accumulate() re-arms the timer.
 */
function flushTextDeltas(): void {
  if (pendingTextDeltas.size === 0) {
    if (deltaFlushTimer) {
      clearInterval(deltaFlushTimer)
      deltaFlushTimer = null
    }
    return
  }
  for (const [deltaKey, text] of pendingTextDeltas) {
    if (state.remoteTransport) {
      const { tabId, instanceId } = splitWireKey(deltaKey)
      state.remoteTransport.send({ type: 'desktop_text_delta', tabId, instanceId, text })
    }
  }
  pendingTextDeltas.clear()
}

/** Accumulate a delta for `key` and ensure the flush timer is running. */
export function accumulateTextDelta(key: string, text: string): void {
  pendingTextDeltas.set(key, (pendingTextDeltas.get(key) || '') + (text || ''))
  if (!deltaFlushTimer) {
    deltaFlushTimer = setInterval(flushTextDeltas, 16)
  }
}

/**
 * Flush any buffered text for `key` IMMEDIATELY, ahead of a same-key envelope
 * about to be sent. This is the single ordering guarantee every same-key
 * immediate emitter must call first: engine_message_end / engine_tool_start
 * (seal/boundary), the /clear divider, and the compaction marker. Both the text
 * delta and those envelopes are CRITICAL_TYPES on a FIFO transport, so flushing
 * here puts the text at a lower seq than the following frame — iOS applies text
 * before it seals/dividers the row. A no-op when the key has no pending text.
 */
export function flushKeyDeltas(key: string): void {
  const text = pendingTextDeltas.get(key)
  if (!text || !state.remoteTransport) return
  pendingTextDeltas.delete(key)
  const { tabId, instanceId } = splitWireKey(key)
  state.remoteTransport.send({ type: 'desktop_text_delta', tabId, instanceId, text })
}

/**
 * Flush every buffered key belonging to `tabId`, ahead of a same-tab envelope
 * whose emitter only knows the tab (not the wire key's instance segment) — e.g.
 * the compaction marker in event-wiring-remote.ts, a sessionPlane listener that
 * receives a bare tabId. A conversation's delta key is either bare (`tabId`) or
 * compound (`tabId:instanceId`); this drains both shapes so the marker can never
 * out-race pending text for the tab. Same FIFO ordering guarantee as
 * flushKeyDeltas, widened from one key to one tab.
 */
export function flushTabDeltas(tabId: string): void {
  for (const key of pendingTextDeltas.keys()) {
    if (key === tabId || key.startsWith(`${tabId}:`)) {
      flushKeyDeltas(key)
    }
  }
}

/**
 * Drop buffered text for `key` WITHOUT sending. engine_stream_reset discards the
 * failed attempt's partial output on every client; the batched-but-unsent text
 * for that key belongs to the discarded attempt and must not be delivered after
 * the reset frame.
 */
export function dropKeyDeltas(key: string): void {
  pendingTextDeltas.delete(key)
}

/**
 * Test-only: clear the module-scoped buffer + timer between test cases. The
 * batcher is module-scoped by design (shared across event-wiring.ts and
 * event-wiring-remote.ts), so unit tests that re-wire the handlers must reset it
 * to avoid cross-test leakage of pending text or a live interval.
 */
export function __resetTextDeltaBatcherForTest(): void {
  pendingTextDeltas.clear()
  if (deltaFlushTimer) {
    clearInterval(deltaFlushTimer)
    deltaFlushTimer = null
  }
}
