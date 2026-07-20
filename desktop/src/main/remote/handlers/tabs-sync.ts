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
 * force semantics: it always sends regardless of the poll gate's hash state
 * (an explicit sync means the client may have missed deltas and is asking
 * for a full refresh — suppressing it is the "missed a delta, never re-sent"
 * freeze). After sending it updates the per-device snapshot hash via
 * noteSnapshotSentToDevices so the next poll tick does not immediately
 * re-send the same snapshot to the devices that just received it. The former
 * forceSyncSnapshot in snapshot-polling.ts (which built a SECOND full
 * snapshot alongside this one — two full builds + sends per sync) is retired.
 */

import { log as _log, debug as _debug } from '../../logger'
import { state, terminalScrollback } from '../../state'
import { readSettings } from '../../settings-store'
import { projectCurrentSettings, projectableSchema, projectableGroups } from '../../projectable-settings'
import { buildSnapshotEvent, noteSnapshotSentToDevices } from '../snapshot-polling'
import { readRemoteDisplay } from './display'
import { getEnterprisePolicyNewConversationDefaults } from '../../engine-bridge-fs'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

/** Broadcast sync to all connected devices (used after state-changing operations). */
export async function broadcastSync(): Promise<void> {
  const deviceIds = state.remoteTransport?.getConnectedDeviceIds() ?? []
  await sendSync((event) => state.remoteTransport?.send(event), deviceIds)
}

/**
 * Build a snapshot envelope and hand it to the supplied sender. The sender
 * decides whether to broadcast to all devices or send to one — that policy
 * is kept on the caller side.
 *
 * `recipientDeviceIds` names the devices the sender delivers to, so the
 * per-device poll-gate hash can be updated for exactly those devices (B7):
 * a forced sync to device A must not suppress the next poll send to device
 * B. Callers that cannot enumerate recipients pass [] and the poll simply
 * re-sends on its next tick (correct, just not optimal).
 *
 * The snapshot base comes from the shared buildSnapshotEvent (identical to
 * the poll tick's build — the precondition for the hash update to match);
 * the remote-display fields are layered on top and are hash-excluded.
 */
export async function sendSync(send: (event: any) => void, recipientDeviceIds: string[] = []): Promise<void> {
  const { event: snapshotBase, tabs } = await buildSnapshotEvent()
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
  // Update the per-device poll-gate hash for the devices that just received
  // this snapshot so the next poll tick does not double-send. The layered
  // remote-display fields are hash-excluded, so this hash equals the hash
  // the next poll tick computes for unchanged state.
  noteSnapshotSentToDevices(snapshotEvent, recipientDeviceIds)
  const engineProfiles = Array.isArray(syncSettings.engineProfiles) ? syncSettings.engineProfiles : []
  send({ type: 'desktop_engine_profiles', profiles: engineProfiles })
  // Desktop projectable settings snapshot. Carried alongside the main
  // `snapshot` payload so iOS sees the desktop's user preferences from
  // the moment of pairing. Snapshot semantics — consumers replace their
  // cached view with the payload, never merge. See
  // `desktop/src/main/projectable-settings.ts` for the canonical
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
  send({
    type: 'desktop_settings_snapshot',
    settings: projectCurrentSettings(),
    schema: projectableSchema(),
    groups: projectableGroups(),
    newConversationPolicy,
  })
  for (const tab of tabs) {
    if (tab.isTerminalOnly && tab.terminalInstances && tab.terminalInstances.length > 0) {
      try {
        const escapedTabId = tab.id.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        const buffers: Record<string, string> = await state.mainWindow?.webContents.executeJavaScript(`
          (function() {
            try {
              var store = window.__Ion_SESSION_STORE__;
              if (!store) return {};
              var pane = store.getState().terminalPanes.get('${escapedTabId}');
              if (!pane) return {};
              var result = {};
              for (var i = 0; i < pane.instances.length; i++) {
                var key = '${escapedTabId}:' + pane.instances[i].id;
                var buf = window.__serializeTerminalBuffer ? window.__serializeTerminalBuffer(key) : null;
                if (buf) result[pane.instances[i].id] = buf;
              }
              return result;
            } catch(e) { return {}; }
          })()
        `) || {}
        // Fall back to main-process scrollback for instances without renderer xterm
        for (const inst of tab.terminalInstances!) {
          if (!buffers[inst.id]) {
            const scrollback = terminalScrollback.get(`${tab.id}:${inst.id}`)
            if (scrollback) buffers[inst.id] = scrollback
          }
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
