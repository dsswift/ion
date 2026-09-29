/**
 * remote-projection-push — debounced, change-gated projection push.
 *
 * Window-free by construction: `getState`, `subscribe`, and `push` are
 * injected, so the server's store owner drives it and no Studio client ever
 * does.
 *
 * Debounce: trailing ~250 ms. Store changes arrive in bursts (streamed
 * deltas mutate messages on every chunk); one projection per burst is enough
 * because the consumers (5 s snapshot poll tick, forced sync, pairing)
 * tolerate sub-second staleness by design. A fingerprint of the projected
 * payload suppresses pushes when the projection is unchanged (e.g. a store
 * change in per-window UI state that the projection ignores).
 */
import { rDebug, rError } from './rendererLogger'
import { projectRemoteTabStates } from './remote-projection'

/** Trailing debounce window for projection recompute + push. */
export const PUSH_DEBOUNCE_MS = 250

export interface PushDeps {
  /** Read current store state. */
  getState: () => Parameters<typeof projectRemoteTabStates>[0]
  /** Subscribe to store changes; returns unsubscribe. */
  subscribe: (listener: () => void) => () => void
  /** Deliver the payload to the push target. */
  push: (payload: ReturnType<typeof projectRemoteTabStates>) => void
}

/**
 * Core wiring, dependency-injected for unit tests and for the desktop
 * renderer's window-aware wrapper.
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
      // Never fail silently: a projection failure means the push target
      // serves a stale cache (or its legacy fallback poll) until the next
      // store change.
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

  // Startup push: seed the target with the current (possibly pre-hydration)
  // state immediately, then again on every change — tab restoration mutates
  // the store, so hydration completion triggers the subscription push
  // naturally.
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
