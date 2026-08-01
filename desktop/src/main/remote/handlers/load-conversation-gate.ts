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
// The gate coalesces REDUNDANT identical requests: a repeat of the same
// (device, tabId, before) within COALESCE_WINDOW_MS carries no new information,
// because the device already received (or is about to receive) that exact page.
// Legitimate pagination is never affected — it advances the `before` cursor,
// producing a different key each step. This is a desktop-side defense that holds
// regardless of why the client loops; it does not depend on fixing the client.
//
// ─── Why a coalesced request is ANSWERED, not dropped ───────────────────────
//
// The gate originally returned a bare boolean and the caller bare-`return`ed on
// false. That left the client with a request it had marked in flight and no
// response — a silent failure (root AGENTS.md § "No silent failures"). iOS's
// only recovery was `startLoadTimer`'s 5s retry, which is the entire lifetime of
// the "Loading conversation…" spinner on a brand-new, history-less tab.
//
// So the verdict is now three-valued. The FIRST duplicate inside a window is
// answered from the cached response of the request that populated the window —
// no engine round-trip, no renderer hop, no re-pagination, just a re-send of
// bytes already computed. Any further duplicate in the same window drops, so a
// genuinely pathological client is still bounded: the amplification ceiling is
// 2x, against the 60-120/sec flood this gate was built to absorb.
//
// The replay is only possible once a response exists. A duplicate that arrives
// while the first request is still in flight (the common self-collision case)
// has nothing to replay and drops — the in-flight response is already addressed
// to the same device and will satisfy the client.

import { log as _log } from '../../logger'
import type { RemoteEvent } from '../protocol'

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

/**
 * key -> the response we sent for the request that opened the current window,
 * plus whether we have already replayed it once. Populated by
 * `recordLoadResponse` after the handler builds a page; read by a `'replay'`
 * verdict. Entries live and die with `lastServedByKey` (same prune sweep, same
 * device clear), so the cache can never outlive its window bookkeeping.
 */
interface CachedResponse {
  event: RemoteEvent
  replayed: boolean
}
const responseByKey = new Map<string, CachedResponse>()

function keyFor(deviceId: string, tabId: string, before: string | undefined): string {
  // Space separators: device/tab ids are UUIDs and message-id cursors carry no
  // spaces, so the key is unambiguous without escaping.
  return `${deviceId} ${tabId} ${before ?? ''}`
}

function prune(now: number): void {
  if (lastServedByKey.size < PRUNE_SIZE_THRESHOLD) return
  for (const [k, t] of lastServedByKey) {
    if (now - t > PRUNE_AFTER_MS) {
      lastServedByKey.delete(k)
      responseByKey.delete(k)
    }
  }
}

/** What the caller should do with a `desktop_load_conversation` request. */
export type LoadVerdict =
  /** First request for this key, or the window has elapsed: build and send a fresh page. */
  | { action: 'serve' }
  /** Redundant repeat and we still hold the response: re-send these exact bytes. */
  | { action: 'replay'; event: RemoteEvent }
  /** Redundant repeat with nothing to replay (or already replayed once): ignore. */
  | { action: 'drop' }

/**
 * Decide what to do with a load_conversation request.
 *
 *  - `'serve'`  — first occurrence of a (device, tabId, before) key, or any
 *                 occurrence outside the coalesce window. Records the timestamp;
 *                 the caller must call `recordLoadResponse` with the page it
 *                 builds so a duplicate can be answered from it.
 *  - `'replay'` — redundant repeat inside the window AND a cached response from
 *                 this window exists and has not been replayed yet. The caller
 *                 re-sends the cached event verbatim. Marks the entry replayed.
 *  - `'drop'`   — redundant repeat with no cached response yet (the first
 *                 request is still in flight and will answer the client), or the
 *                 one permitted replay has already been used.
 *
 * `now` is injectable for tests.
 */
export function decideLoad(
  deviceId: string,
  tabId: string,
  before: string | undefined,
  now: number = Date.now(),
): LoadVerdict {
  const k = keyFor(deviceId, tabId, before)
  const last = lastServedByKey.get(k)
  if (last !== undefined && now - last < COALESCE_WINDOW_MS) {
    const cached = responseByKey.get(k)
    if (cached && !cached.replayed) {
      cached.replayed = true
      log('coalesced duplicate load: replaying cached page', { tab_id: tabId, device: deviceId.slice(0, 8), age_ms: now - last })
      return { action: 'replay', event: cached.event }
    }
    log('coalesced duplicate load', {
      tab_id: tabId,
      device: deviceId.slice(0, 8),
      age_ms: now - last,
      reason: cached ? 'already_replayed' : 'response_in_flight',
    })
    return { action: 'drop' }
  }
  lastServedByKey.set(k, now)
  // A fresh window supersedes any response cached for the previous one.
  responseByKey.delete(k)
  prune(now)
  return { action: 'serve' }
}

/**
 * Record the response sent for a served request so a duplicate inside the same
 * window can be answered from it. Called by the handler for every terminal
 * `desktop_conversation_history` it sends (including the empty no-chain and
 * error responses — a client that re-asks deserves the same answer it would
 * have gotten, not silence).
 */
export function recordLoadResponse(
  deviceId: string,
  tabId: string,
  before: string | undefined,
  event: RemoteEvent,
): void {
  const k = keyFor(deviceId, tabId, before)
  // Only cache while the window that this response belongs to is still open.
  // A response that lands after its window elapsed (a slow engine round-trip)
  // has no duplicate left to answer, and caching it would let a later request
  // in a NEW window replay stale bytes.
  if (!lastServedByKey.has(k)) return
  responseByKey.set(k, { event, replayed: false })
}

/** Drop every gate entry for a device (call on disconnect/unpair). */
export function clearLoadGateForDevice(deviceId: string): void {
  const prefix = `${deviceId} `
  for (const k of lastServedByKey.keys()) {
    if (k.startsWith(prefix)) lastServedByKey.delete(k)
  }
  for (const k of responseByKey.keys()) {
    if (k.startsWith(prefix)) responseByKey.delete(k)
  }
}

/** Test-only: reset all gate state. */
export function _resetLoadGate(): void {
  lastServedByKey.clear()
  responseByKey.clear()
}
