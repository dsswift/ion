/**
 * Single write+broadcast helper for desktop settings.
 *
 * Per docs/engine-grounding.md §6 — "Both edit surfaces funnel through the
 * same main-process write helper — exactly one persistence + broadcast
 * path" — this module is the canonical home for the two operations both
 * edit surfaces (the renderer's SAVE_SETTINGS IPC handler and the iOS
 * `set_desktop_setting` wire command handler) share:
 *
 *   1. Persisting `settings.json` atomically.
 *   2. Broadcasting a fresh `desktop_settings_snapshot` to every paired
 *      iOS device when any projectable key changed.
 *
 * Before this module existed, the two edit surfaces each had their own
 * write + broadcast logic — `ipc/settings.ts` for the renderer path and
 * `remote/handlers/desktop-settings.ts` for the iOS path — with subtly
 * different gating (the renderer path diffed against the prior settings
 * and skipped the broadcast when no projectable key changed; the iOS
 * path always broadcast). Centralising both call sites here makes the
 * "exactly one path" claim literal and gives the audit log one prefix
 * (`[SETTINGS] persistAndBroadcast`) to grep for.
 *
 * Snapshot semantics are inherited from the underlying wire event —
 * consumers REPLACE their cached projection wholesale on every
 * `desktop_settings_snapshot`; never merge. See the contract docs in
 * `projectable-settings.ts` and `docs/architecture/desktop.md` for the
 * full snapshot rules.
 */

import { log as _log } from './logger'
import { state } from './state'
import { broadcast } from './broadcast'
import { writeSettings } from './settings-store'
import { writePlanBashAllowlist } from './plan-bash-allowlist-store'
import { ENGINE_CONFIG_BACKED_KEYS } from './projectable-settings-data'
import {
  isProjectableKey,
  projectCurrentSettings,
  projectableSchema,
  projectableGroups,
} from './projectable-settings'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Broadcast a fresh `desktop_settings_snapshot` to every paired device.
 *
 * Cheap to call: reads `settings.json` once and emits one wire event.
 * Safe to call when no transport is attached (no-op). Logs the broadcast
 * so the operational log shows exactly which call sites triggered a
 * snapshot.
 *
 * Most callers should prefer `persistAndBroadcastSettings()` which gates
 * the broadcast on projectable-key changes. This standalone broadcast is
 * exposed for the rare cases where the schema or grouping shape has
 * changed without a settings-value change (e.g. a future hot-reload of
 * the projectable allowlist), or for unconditional refreshes from
 * higher-level pairing code.
 */
export function broadcastDesktopSettingsSnapshot(reason: string): void {
  if (!state.remoteTransport) {
    log('settings_broadcast: skip, no transport', { reason })
    return
  }
  log('settings_broadcast: sending', { reason })
  state.remoteTransport.send({
    type: 'desktop_settings_snapshot',
    settings: projectCurrentSettings(),
    schema: projectableSchema(),
    groups: projectableGroups(),
  })
}

/**
 * Persist a new settings object and broadcast to paired iOS devices if
 * any projectable key changed.
 *
 * The two edit surfaces call this:
 *
 *   - Renderer SAVE_SETTINGS IPC (`ipc/settings.ts`) passes the full
 *     in-memory settings as `next` and the prior on-disk shape as
 *     `prev`. The diff against the projectable allowlist determines
 *     whether a broadcast is necessary.
 *
 *   - iOS `set_desktop_setting` wire command (`remote/handlers/
 *     desktop-settings.ts`) passes a merged object as `next` and the
 *     pre-merge shape as `prev`. Validation has already gated the key
 *     against the allowlist by this point — the diff still runs so the
 *     broadcast is skipped when iOS posts a no-op write (same value
 *     it already had).
 *
 * `prev` MUST be the pre-write snapshot; pass `{}` when there is no
 * prior state (the first write on a fresh install). Passing `null`
 * forces a broadcast regardless of the diff — useful for code paths
 * where the caller already knows a broadcast is required (e.g. a
 * schema reload) but persistence still needs to go through this
 * helper for the single-path guarantee.
 *
 * Throws when `writeSettings` throws — atomic write failures are
 * surfaced to the caller rather than swallowed. The broadcast is
 * skipped on write failure to keep the in-memory wire state consistent
 * with the on-disk truth.
 *
 * Logging: every call logs the projectable-key delta. Verbose by design
 * — settings writes are infrequent and the log line is the audit trail
 * the user sees when they ask "what just changed on my paired devices?".
 */
export function persistAndBroadcastSettings(
  next: Record<string, unknown>,
  prev: Record<string, unknown> | null,
): void {
  // Engine-config-backed keys (e.g. the plan-mode Bash allowlist) are ENGINE
  // POLICY: their canonical store is engine.json, not settings.json. Route
  // each such key to engine.json and strip it from the settings.json write so
  // it never lands in two places. Both edit surfaces (renderer SAVE_SETTINGS,
  // iOS set_desktop_setting) funnel here, so this one seam covers iOS too.
  // The key stays visible to the projection layer (projectCurrentSettings
  // reads it back from engine.json), so the projectable-change diff below and
  // the desktop_settings_snapshot still reflect it for paired devices.
  let engineBackedChanged = false
  for (const key of Object.keys(next)) {
    if (!ENGINE_CONFIG_BACKED_KEYS.has(key)) continue
    const value = next[key]
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      writePlanBashAllowlist(value as string[])
      engineBackedChanged = true
    } else {
      log('settings_broadcast: engine-backed key has non-string-array value, skipping', { key })
    }
    delete next[key]
  }

  writeSettings(next as Record<string, any>)

  // Cross-window prefs sync (mirror-store architecture): every changed key
  // is pushed as ion:settings-changed so BOTH renderer preference stores
  // (overlay owner + ATV mirror) converge, whichever window wrote. The
  // writer's own echo is a no-op — the renderer listener patches only when
  // the in-memory value differs.
  if (prev !== null) {
    for (const key of Object.keys(next)) {
      if (next[key] !== prev[key]) {
        broadcast('ion:settings-changed', key, next[key])
      }
    }
  }

  const forceBroadcast = prev === null
  let changedProjectableKeys: string[] = []
  if (!forceBroadcast) {
    changedProjectableKeys = Object.keys(next).filter((k) => {
      if (!isProjectableKey(k)) return false
      return next[k] !== prev![k]
    })
  }

  if (forceBroadcast) {
    log(`[SETTINGS] persistAndBroadcast: forced broadcast (prev=null)`)
    broadcastDesktopSettingsSnapshot('persistAndBroadcast:forced')
    return
  }

  if (changedProjectableKeys.length === 0 && !engineBackedChanged) {
    log(`[SETTINGS] persistAndBroadcast: no projectable keys changed, skipping broadcast`)
    return
  }

  log('settings_broadcast: projectable changed', { keys: changedProjectableKeys.join(','), engine_backed: engineBackedChanged })
  broadcastDesktopSettingsSnapshot('persistAndBroadcast:projectable_changed')
}
