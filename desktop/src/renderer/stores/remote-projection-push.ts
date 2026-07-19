/**
 * remote-projection-push — renderer-side push of the remote tab-state
 * projection to the main process.
 *
 * Replaces the main process's 5 s `executeJavaScript` poll: instead of the
 * main process evaluating a projection IIFE in the renderer on every tick
 * (jank on the renderer main thread, untypecheckable string code), the
 * renderer subscribes to its own session store, recomputes the projection
 * (remote-projection.ts) debounced on change, and pushes the result over the
 * preload bridge (window.ion.pushRemoteTabStates). The main process caches
 * the payload and serves `getRemoteTabStates()` from that cache.
 *
 * Owner-window only: the ATV mirror window runs the same session store in
 * MIRROR mode (see renderer/atv/README.md and ADR-021) and must never push —
 * the overlay renderer is the single writer/answerer for snapshot state, and
 * a second pusher would race it with potentially stale mirror state. The
 * guard uses isMirrorWindow() (entry-file detection, no init-order
 * dependency). This is not a store action, so no atv-mirror-actions
 * classification applies.
 *
 * Debounce: trailing ~250 ms. Store changes arrive in bursts (streamed
 * deltas mutate messages on every chunk); one projection per burst is enough
 * because the main-process consumers (5 s snapshot poll tick, forced sync,
 * pairing) tolerate sub-second staleness by design. A fingerprint of the
 * projected payload suppresses pushes when the projection is unchanged
 * (e.g. a store change in per-window UI state that the projection ignores).
 */

import { useSessionStore } from './sessionStore'
import { isMirrorWindow } from '../lib/window-role'
import { projectRemoteTabStates } from './remote-projection'
import { rDebug, rError, rInfo } from '../rendererLogger'

/** Trailing debounce window for projection recompute + push. */
export const PUSH_DEBOUNCE_MS = 250

interface PushDeps {
  /** Read current store state (defaults to the live session store). */
  getState: () => Parameters<typeof projectRemoteTabStates>[0]
  /** Subscribe to store changes; returns unsubscribe. */
  subscribe: (listener: () => void) => () => void
  /** Deliver the payload to the main process (defaults to the preload bridge). */
  push: (payload: ReturnType<typeof projectRemoteTabStates>) => void
}

/**
 * Core wiring, dependency-injected for unit tests. Production callers use
 * initRemoteProjectionPush() below.
 */
export function startRemoteProjectionPush(deps: PushDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastPushedFingerprint: string | null = null

  const computeAndPush = (): void => {
    timer = null
    let payload: ReturnType<typeof projectRemoteTabStates>
    try {
      payload = projectRemoteTabStates(deps.getState())
    } catch (err) {
      // Never fail silently: a projection failure means the main process
      // serves a stale cache (or its legacy fallback poll) until the next
      // store change. The legacy IIFE had the same failure mode behind a
      // console.error; this is the structured, observable equivalent.
      rError('remote-projection-push', 'projection failed; push skipped', {
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    // Cheap change gate: serialize once and compare against the last pushed
    // payload. JSON.stringify is bounded by tab count × projection size (the
    // same object the IPC layer would structured-clone anyway); identical
    // projections are the common case for UI-only store churn.
    const fingerprint = JSON.stringify(payload)
    if (fingerprint === lastPushedFingerprint) {
      rDebug('remote-projection-push', 'projection unchanged; push suppressed', { tab_count: payload.tabs.length })
      return
    }
    lastPushedFingerprint = fingerprint
    deps.push(payload)
    rDebug('remote-projection-push', 'projection pushed', { tab_count: payload.tabs.length, bytes: fingerprint.length })
  }

  const schedule = (): void => {
    if (timer !== null) return // trailing debounce: burst collapses to one push
    timer = setTimeout(computeAndPush, PUSH_DEBOUNCE_MS)
  }

  // Startup push: seed the main-process cache with the current (possibly
  // pre-hydration) state immediately, then again on every change — tab
  // restoration mutates the store, so hydration completion triggers the
  // subscription push naturally.
  computeAndPush()
  const unsubscribe = deps.subscribe(schedule)

  return () => {
    unsubscribe()
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}

let stop: (() => void) | null = null

/**
 * Start the projection pusher (idempotent). Called once from App mount in the
 * OWNER (overlay) window. Mirror windows no-op — see module doc.
 */
export function initRemoteProjectionPush(): () => void {
  if (stop) return stop
  if (isMirrorWindow()) {
    rInfo('remote-projection-push', 'mirror window; projection push disabled')
    return () => { /* mirror never started */ }
  }
  if (typeof window.ion?.pushRemoteTabStates !== 'function') {
    // Preload bridge absent (renderer unit tests without preload). Observable
    // no-op rather than a throw during App mount.
    rError('remote-projection-push', 'preload bridge missing pushRemoteTabStates; push disabled')
    return () => { /* bridge absent */ }
  }
  const inner = startRemoteProjectionPush({
    getState: () => useSessionStore.getState(),
    subscribe: (listener) => useSessionStore.subscribe(listener),
    push: (payload) => window.ion.pushRemoteTabStates(payload),
  })
  stop = () => {
    inner()
    stop = null
  }
  rInfo('remote-projection-push', 'projection push started', { debounce_ms: PUSH_DEBOUNCE_MS })
  return stop
}
