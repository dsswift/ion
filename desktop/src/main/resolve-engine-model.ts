// resolve-engine-model.ts — main-process resolution of a tab's effective model.
//
// Mirrors the renderer's `__Ion_resolveEngineModel` (sessionStore.ts) so the
// main process can answer an iOS resync without an executeJavaScript round-trip
// into the renderer. The desktop guide is explicit that string-interpolated
// executeJavaScript is to be avoided; this removes one of the two remaining
// callers.
//
// Both inputs are already main-owned, which is what makes this a relocation
// rather than a reimplementation: the per-instance override rides the renderer
// tab-state push (`state.rendererSnapshotCache`), and the two preference
// fallbacks live in main's own settings store.

import { state } from './state'
import { readSettings } from './settings-store'
import { debug } from './logger'

/**
 * Final fallback when neither an override nor a preference is set.
 *
 * Kept identical to the renderer's literal on purpose. Two divergent
 * fallbacks would surface as the phone and the desktop disagreeing about
 * which model a tab is on — a difference nobody would think to look for.
 */
const FALLBACK_MODEL = 'claude-sonnet-4-6'

/**
 * Resolve the model a tab is effectively using.
 *
 * Precedence, matching the renderer exactly:
 *   per-instance override → engineDefaultModel → preferredModel → fallback
 */
export function resolveEngineModel(tabId: string, instanceId?: string | null): string {
  // The projection carries modelOverride at tab level only — snapshot.ts sets
  // it from the tab's active instance, so it already IS the effective
  // per-instance override. instanceId is accepted for logging and so callers
  // need not special-case it.
  const tab = state.rendererSnapshotCache?.tabs?.find((t) => t.id === tabId)
  const override = tab?.modelOverride

  if (override) {
    debug('main', 'resolve_engine_model', {
      tab_id: tabId, instance_id: instanceId ?? null, source: 'override', model: override,
    })
    return override
  }

  const settings = readSettings()
  const resolved =
    (settings.engineDefaultModel as string) ||
    (settings.preferredModel as string) ||
    FALLBACK_MODEL

  debug('main', 'resolve_engine_model', {
    tab_id: tabId, instance_id: instanceId ?? null, source: 'settings', model: resolved,
  })
  return resolved
}
