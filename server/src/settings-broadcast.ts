/**
 * Single write+broadcast helper for server settings.
 *
 * Every write to this server's settings document funnels through
 * `persistAndBroadcastSettings`: `settings.save`, the phone's
 * `settings.setProjectable`, and the server's own writers (projects, graph
 * views, project Studio config). It does two things:
 *
 *   1. Persisting `settings.json` atomically.
 *   2. Broadcasting a fresh `desktop_settings_snapshot` to every paired
 *      device when any projectable key changed.
 *
 * One funnel means one gate on what reaches disk (the engine-backed keys)
 * and one log prefix (`[SETTINGS] persistAndBroadcast`) to grep for. A write to a person's overlay does not come through here;
 * its writer calls `broadcastDesktopSettingsSnapshot` itself.
 *
 * Snapshot semantics are inherited from the underlying wire event —
 * consumers REPLACE their cached projection wholesale on every
 * `desktop_settings_snapshot`; never merge. See the contract docs in
 * `projectable-settings.ts` and `docs/architecture/desktop.md` for the
 * full snapshot rules.
 */

import { log as _log } from './logger'
import { enterprisePolicyCache } from './state'
import { newConversationDefaultsFor } from './enterprise-policy-principal'
import { broadcast } from './broadcast'
import { handleSettingsChangeForClientTools } from './studio-client-tool-sync'
import { writeSettings } from './persistence/settings-store'
import { writePlanBashAllowlist } from './plan-bash-allowlist-store'
import { ENGINE_CONFIG_BACKED_KEYS } from './projectable-settings-data'
import { getEnterpriseThemePolicy } from './theme-policy'
import {
  isProjectableKey,
  projectCurrentSettings,
  projectableSchema,
  projectableGroups,
  projectablePages,
} from './projectable-settings'
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import type { Scope } from '@ion/shared/studio-wire/types'
import type { RemoteEvent } from './remote/protocol'
import { sendThinEventTo, thinConnections } from './thin-view/remote-out'

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
  const conns = thinConnections().filter((conn) => conn.principal !== null)
  if (conns.length === 0) {
    log('settings_broadcast: skip, no transport', { reason })
    return
  }
  // One snapshot per connection, not one for all: the values are the
  // connection's own (Account settings live in its person's overlay), and
  // whether it may change the Environment depends on its own scopes.
  let sent = 0
  for (const conn of conns) {
    const subject = conn.principal!.subject
    const defaults = newConversationDefaultsFor(subject)
    const event = buildDesktopSettingsSnapshot(subject, conn.scopes, defaults === undefined ? enterprisePolicyCache.newConversationDefaults : defaults)
    if (sendThinEventTo(conn, event)) sent++
  }
  log('settings_broadcast: sent', { reason, connections: conns.length, sent })
}

/**
 * The `desktop_settings_snapshot` for one client: `subject`'s values, and
 * whether `scopes` lets it change this server's Environment settings. One
 * builder for the change broadcast above and the first-paint sync
 * (`remote/handlers/tabs-sync.ts`), so the two cannot describe a setting
 * differently.
 */
export function buildDesktopSettingsSnapshot(
  subject: string,
  scopes: readonly Scope[],
  newConversationPolicy: { baseDirectory: string; engineProfileId: string; locked: boolean } | null,
): Extract<RemoteEvent, { type: 'desktop_settings_snapshot' }> {
  return {
    type: 'desktop_settings_snapshot',
    settings: projectCurrentSettings(subject),
    schema: projectableSchema(),
    groups: projectableGroups(),
    // The pages and sections to lay the schema out under, in Studio's order.
    pages: projectablePages(),
    // Enterprise policies ride every snapshot from the main-process cache
    // (no RPC — the cache is populated at startup and refreshed at each
    // sendSync). Omitting them here used to leave iOS with a stale policy
    // view after a settings-triggered rebroadcast.
    newConversationPolicy,
    // Enterprise theme policy — enforced/suggested theme + picker lock,
    // mirrored on iOS. Null when unmanaged.
    themePolicy: getEnterpriseThemePolicy(),
    // Each schema entry carries its scope. A client renders an `environment`
    // entry read-only unless this is true; the server refuses the write
    // either way (`admin_required`).
    canManageEnvironment: scopeSatisfies(scopes, 'admin'),
  }
}

/**
 * Persist a new settings object and broadcast to paired devices if any
 * projectable key changed.
 *
 * Callers pass the merged document as `next` and the pre-merge shape as
 * `prev` (`settings.save`, `applyProjectableSetting`, and the server's own
 * writers). The diff against the projectable allowlist decides whether a
 * broadcast is needed, so a write that repeats the value it already had
 * sends nothing.
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
  // it never lands in two places. Every settings-document write funnels
  // here, so this one seam covers the phone too.
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

  writeSettings(next)

  // Studio-only client-tool availability depends on activeUi (charts and the
  // browser set) and studioPlaywrightEnabled (browser set only), and the engine
  // learns a session's tool list at start_session. Funnelling the resync here
  // means every writer converges on one implementation.
  handleSettingsChangeForClientTools(next as Record<string, unknown>, prev)

  // Cross-window prefs sync (mirror-store architecture): every changed key
  // is pushed as ion:settings-changed so BOTH renderer preference stores
  // (overlay owner + Studio mirror) converge, whichever window wrote. The
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
