// Coalescing gate for desktop_load_conversation.
//
// A paired device (notably iOS, which reloads stale conversations on reconnect)
// can fire the same history request 60-120x/second — re-requesting the exact
// same page for ~26 conversations in a tight loop when a connection flaps.
// Every request drives an executeJavaScript round-trip into the renderer plus a
// serialize->compress->encrypt->send of a 10-40KB payload fanned to every paired
// device. Sustained, that flood backs up the relay send path and was implicated
// in a 30+ minute main-thread wedge.
//
// The gate drops REDUNDANT identical requests: a repeat of the same
// (device, tabId, before) within COALESCE_WINDOW_MS is dropped, because the
// device already received (or is about to receive) that exact page. Legitimate
// pagination is never affected — it advances the `before` cursor, producing a
// different key each step. This is a desktop-side defense that holds regardless
// of why the client loops; it does not depend on fixing the client.

import { log as _log } from '../../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('load-conversation-gate', msg, fields) }

/**
 * How long an identical (device, tabId, before) request is considered a
 * redundant repeat. A re-request of the same page inside this window carries no
 * new information for the client, so it is dropped. Kept short so genuinely
 * fresh reloads (after the conversation changes) still flow within ~1s.
 */
export const COALESCE_WINDOW_MS = 1000

/** Prune entries older than this so the map cannot grow without bound. */
const PRUNE_AFTER_MS = 60_000
/** Only bother pruning once the map is non-trivially large. */
const PRUNE_SIZE_THRESHOLD = 256

// key -> epoch ms of the last time this exact request was served.
const lastServedByKey = new Map<string, number>()

function keyFor(deviceId: string, tabId: string, before: string | undefined): string {
  // Space separators: device/tab ids are UUIDs and message-id cursors carry no
  // spaces, so the key is unambiguous without escaping.
  return `${deviceId} ${tabId} ${before ?? ''}`
}

function prune(now: number): void {
  if (lastServedByKey.size < PRUNE_SIZE_THRESHOLD) return
  for (const [k, t] of lastServedByKey) {
    if (now - t > PRUNE_AFTER_MS) lastServedByKey.delete(k)
  }
}

/**
 * Decide whether to serve a load_conversation request. Returns true (and records
 * the timestamp) for the first occurrence of a (device, tabId, before) key and
 * for any occurrence outside the coalesce window. Returns false for a redundant
 * repeat inside the window — the caller should drop it.
 *
 * `now` is injectable for tests.
 */
export function shouldServeLoad(
  deviceId: string,
  tabId: string,
  before: string | undefined,
  now: number = Date.now(),
): boolean {
  const k = keyFor(deviceId, tabId, before)
  const last = lastServedByKey.get(k)
  if (last !== undefined && now - last < COALESCE_WINDOW_MS) {
    log('coalesced duplicate load', { tab_id: tabId, device: deviceId.slice(0, 8), age_ms: now - last })
    return false
  }
  lastServedByKey.set(k, now)
  prune(now)
  return true
}

/** Drop every gate entry for a device (call on disconnect/unpair). */
export function clearLoadGateForDevice(deviceId: string): void {
  const prefix = `${deviceId} `
  for (const k of lastServedByKey.keys()) {
    if (k.startsWith(prefix)) lastServedByKey.delete(k)
  }
}

/** Test-only: reset all gate state. */
export function _resetLoadGate(): void {
  lastServedByKey.clear()
}
