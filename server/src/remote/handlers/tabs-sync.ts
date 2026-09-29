/**
 * Snapshot sync helpers for remote handlers.
 *
 * Extracted so multiple handler modules (tabs.ts, tab-groups.ts) can call
 * `broadcastSync` without each one re-implementing the snapshot assembly
 * or having to import `tabs.ts` (which would create a cycle once
 * tab-groups.ts is split out).
 *
 * `broadcastSync` sends a `snapshot` event to every connected device.
 * `sendSync` targets a single device by id (used by `handleSync` on
 * device pairing / reconnect).
 *
 * sendSync is the SINGLE snapshot sender for the explicit-sync path, with
 * force semantics: it always sends regardless of any gate's hash state (an
 * explicit sync means the client may have missed deltas and is asking for a
 * full refresh — suppressing it is the "missed a delta, never re-sent"
 * freeze). Priming the gate so the next tick does not double-send is the
 * sender's job: sendThinFirstPaint records the hash of what it sent as it
 * sends it (thin-view/thin-sync.ts).
 */

import { log as _log, debug as _debug } from '../../logger'
import { terminalScrollback, enterprisePolicyCache } from '../../state'
import { readSettings } from '../../persistence/settings-store'
import { buildDesktopSettingsSnapshot } from '../../settings-broadcast'
import type { Scope } from '@ion/shared/studio-wire/types'
import { localPrincipal } from '../../identity/local-principal'
import { buildSnapshotEvent } from '../snapshot-polling'
import { readRemoteDisplay } from './display'
import { getEnterprisePolicyNewConversationDefaults } from '../../engine/engine-bridge-fs'
import { buildThemeManifest, rescanThemePacks } from '../../theme-packs'
import { thinConnections } from '../../thin-view/remote-out'
import { sendThinFirstPaint } from '../../thin-view/thin-sync'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

/**
 * Re-send the whole sync envelope to every attached client, used after a
 * state-changing operation. Each one is built for its own principal: an
 * unscoped snapshot names every principal's tabs, and a snapshot names no
 * single tab for the fan-out's ownership rule to filter on.
 */
export async function broadcastSync(): Promise<void> {
  await Promise.all(thinConnections().map((conn) => sendThinFirstPaint(conn)))
}

/**
 * Build a snapshot envelope and hand it to the supplied sender. The sender
 * decides who it delivers to and records what it sent — that policy is kept
 * on the caller side.
 *
 * The snapshot base comes from the shared buildSnapshotEvent (identical to
 * the poll tick's build — the precondition for a sender's gate hash to match
 * the next tick's); the remote-display fields are layered on top and are
 * hash-excluded.
 *
 * `forSubject` (child 09) scopes the tab list to one device's principal —
 * pass it when `send` targets exactly the device that subject belongs to
 * (single-recipient calls, e.g. a fresh pairing or connect). Broadcast
 * callers (state changes fanned to every connected device) omit it: every
 * paired device shares one local principal when the server has no `oidc`
 * block, so unscoped is correct there, and scoping a true multi-subject
 * broadcast to one subject would hide it from everyone else.
 */
export async function sendSync(send: (event: any) => void, forSubject?: string, scopes: readonly Scope[] = []): Promise<void> {
  const { event: snapshotBase, tabs } = await buildSnapshotEvent(forSubject)
  const syncSettings = readSettings()
  const remoteDisplay = readRemoteDisplay()
  log('snap_send', { tab_count: tabs.length, dir_count: Array.isArray(snapshotBase.recentDirectories) ? (snapshotBase.recentDirectories as string[]).length : 0, has_remote_display: !!remoteDisplay })
  const snapshotEvent: Record<string, unknown> = {
    ...snapshotBase,
    customName: remoteDisplay?.customName ?? undefined,
    customIcon: remoteDisplay?.customIcon ?? undefined,
    remoteDisplayUpdatedAt: remoteDisplay?.updatedAt ?? undefined,
  }
  send(snapshotEvent)
  const engineProfiles = Array.isArray(syncSettings.engineProfiles) ? syncSettings.engineProfiles : []
  send({ type: 'desktop_engine_profiles', profiles: engineProfiles })
  // Desktop projectable settings snapshot. Carried alongside the main
  // `snapshot` payload so iOS sees the desktop's user preferences from
  // the moment of pairing. Snapshot semantics — consumers replace their
  // cached view with the payload, never merge. See
  // `projectable-settings.ts` for the canonical
  // allowlist and the rationale for which settings are projected. The
  // schema + groups ride alongside the values so iOS auto-renders the
  // Settings detail view without hardcoding the projection metadata.
  //
  // `newConversationPolicy` projects the resolved enterprise new-tab lock so
  // remote clients enforce the same constraint as the desktop. The policy
  // comes from the local engine IPC (`get_enterprise_policy`) and is NOT
  // a user-editable setting, so it lives as a discrete top-level field
  // rather than inside the `settings` key-value map.
  let newConversationPolicy: { baseDirectory: string; engineProfileId: string; locked: boolean } | null = null
  try {
    const policy = await getEnterprisePolicyNewConversationDefaults()
    if (policy) {
      newConversationPolicy = { baseDirectory: policy.baseDirectory, engineProfileId: policy.engineProfileId, locked: policy.locked }
    }
  } catch (err) {
    log('snap_send: enterprise policy fetch failed', { error: String(err) })
  }
  // Refresh the main-process cache so synchronous emitters
  // (broadcastDesktopSettingsSnapshot) project the same policy without an RPC.
  enterprisePolicyCache.newConversationDefaults = newConversationPolicy
  send(buildDesktopSettingsSnapshot(forSubject ?? localPrincipal().subject, scopes, newConversationPolicy))
  // Custom theme packs: rescan the disk roots (an MDM may have dropped a
  // pack since the last connect), then ship the iOS components. Sync runs
  // on first pairing AND every reconnect, which is what keeps iOS
  // converged with the desktop's installed theme set. If the rescan found
  // changes, the theme-packs change listeners also push the refreshed set
  // to the desktop renderers — sendSync stays the single wire emitter here.
  rescanThemePacks()
  const themeManifest = buildThemeManifest()
  log('snap_send: theme manifest', { theme_count: themeManifest.themes.length, hash: themeManifest.hash })
  send({ type: 'desktop_theme_manifest', ...themeManifest })
  for (const tab of tabs) {
    if (tab.isTerminalOnly && tab.terminalInstances && tab.terminalInstances.length > 0) {
      try {
        // The live xterm.js scrollback buffer only exists in a browser DOM,
        // which this in-process server never has — the server-side
        // accumulator (terminalScrollback, populated from raw PTY output as
        // it streams) is the only available source now, not a fallback for
        // a missing renderer.
        const buffers: Record<string, string> = {}
        for (const inst of tab.terminalInstances) {
          const scrollback = terminalScrollback.get(`${tab.id}:${inst.id}`)
          if (scrollback) buffers[inst.id] = scrollback
        }
        send({
          type: 'desktop_terminal_snapshot',
          tabId: tab.id,
          instances: tab.terminalInstances,
          activeInstanceId: tab.activeTerminalInstanceId || null,
          buffers: Object.keys(buffers).length > 0 ? buffers : undefined,
        })
      } catch (err) {
        // A failed terminal-buffer probe/send drops this tab's snapshot for
        // this sync pass; log so the missing terminal state is diagnosable.
        debug('tabs_sync: terminal snapshot send failed', { tab_id: tab.id, error: String(err) })
      }
    }
  }
}
