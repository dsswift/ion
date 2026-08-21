/**
 * snapshot-renderer-poll — the renderer-poll path, kept solely as the
 * cold-start / stall fallback for the renderer-push snapshot architecture.
 *
 * ── Why this file still exists ──────────────────────────────────────────────
 * The primary snapshot source is the renderer-push cache: the OWNER renderer
 * projects RemoteTabStatesPayload from its session store on change (see
 * renderer/stores/remote-projection.ts + remote-projection-push.ts) and pushes
 * it over IPC.REMOTE_TAB_STATES_PUSH; getRemoteTabStates() (snapshot.ts)
 * serves that cache. This poll runs whenever the cache is empty or older than
 * RENDERER_CACHE_MAX_AGE_MS: renderer not yet hydrated, renderer hung, the
 * push subscription not yet initialized — or simply a desktop that has been
 * idle for ten seconds, which is the common case, not the rare one. This is a
 * cited keep, not dead code: without it a paired iOS device would see zero
 * live tabs for the whole window between desktop launch and the first push.
 *
 * ── One projection, called — not transcribed ────────────────────────────────
 * This file used to carry a ~300-line transcription of the canonical
 * projection as an executeJavaScript template literal, because renderer-scope
 * code cannot import main-process modules. Two implementations of one contract
 * drifted exactly as you would expect: the copy never learned the inbox fields
 * (inboxState / unread / snoozedUntil / settledAt / wokeAt / idleSince) that
 * remote-projection.ts added, so a fallback tick shipped tabs with NO inbox
 * classification while a cache tick shipped the real one. On iOS the Inbox
 * alternated on the poll cadence between correctly-filed projects and every
 * conversation collapsing into Active — a visible flip every few seconds.
 *
 * The fix is to stop transcribing. The renderer publishes the canonical
 * projection on a window global (PROJECTION_GLOBAL, set by
 * remote-projection-push.ts in the OWNER window only) and this poll CALLS it.
 * The IIFE below is now a thin invocation: no field mapping, no inlined
 * predicates, nothing to keep in sync. A field added to the projection reaches
 * the fallback path for free, which is the property the transcription could
 * never provide.
 *
 * ── Renderer-scope constraints (#256 Defect 2) ──────────────────────────────
 * The IIFE is still evaluated in the RENDERER global scope and still cannot
 * reference main-process imports — a stray reference throws a ReferenceError
 * and degrades the snapshot to the cold-start path. Keeping the string down to
 * one global lookup and one call is what makes that class of bug unavailable
 * here rather than merely guarded against.
 *
 * Logging: routes through window.ion.logWrite (the preload logging bridge,
 * same sink as rendererLogger) — never console.* (ADR-019).
 */

import { state } from '../state'
import { debug, warn } from '../logger'
import type { RemoteTabStatesPayload } from '../../shared/remote-projection-types'
import { PROJECTION_GLOBAL } from '../../shared/remote-projection-global'

/**
 * Run the fallback projection once and return the payload.
 *
 * Returns an empty payload when the window is absent, the renderer has not yet
 * published the projection global, or the call throws. An empty result is NOT
 * cached by the caller (see getRemoteTabStates) — it falls through to the
 * cold-start path, so a transient miss during renderer boot cannot pin stale
 * or field-poor rows into the cache for a whole freshness window.
 */
export async function pollRendererTabStates(): Promise<RemoteTabStatesPayload> {
  let result: RemoteTabStatesPayload = { tabs: [], resourceManifest: {} }
  try {
    result = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          // The canonical projection, published by the OWNER renderer
          // (remote-projection-push.ts). Absent means the renderer has not
          // mounted App yet — a real cold start, so the caller's cold-start
          // path is the correct answer rather than a partial projection.
          var project = window['${PROJECTION_GLOBAL}'];
          if (typeof project !== 'function') {
            if (window.ion && typeof window.ion.logWrite === 'function') {
              window.ion.logWrite('DEBUG', 'snapshot-fallback', 'projection global absent; renderer not mounted', {});
            }
            return { tabs: [], resourceManifest: {} };
          }
          return project();
        } catch(e) {
          // Never fail silently. A throw here degrades the fallback snapshot
          // to the cold-start path, so it must be observable. The original
          // ReferenceError (calling a main-process import inside this IIFE)
          // went undetected for exactly this reason. Routed through the
          // logWrite bridge (ADR-019 — no console.* in renderer-evaluated code).
          if (window.ion && typeof window.ion.logWrite === 'function') {
            window.ion.logWrite('ERROR', 'snapshot-fallback', 'projection call failed, degrading to cold-start', { error: (e && e.message ? e.message : String(e)) });
          }
          return { tabs: [], resourceManifest: {} };
        }
      })()
    `) || { tabs: [], resourceManifest: {} }
  } catch (err) {
    // executeJavaScript itself rejected (window mid-teardown, script error
    // outside the IIFE's try). The caller handles the empty payload via the
    // cold-start path, but a persistent rejection means iOS is being served
    // field-poor cold rows, so this is a warning rather than debug noise.
    warn('snapshot-fallback', 'executeJavaScript rejected', { error: (err as Error).message })
    result = { tabs: [], resourceManifest: {} }
  }
  debug('snapshot-fallback', 'fallback projection polled', { tab_count: result.tabs.length })
  return result
}
