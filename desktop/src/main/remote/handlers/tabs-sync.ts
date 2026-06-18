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
 */

import { log as _log } from '../../logger'
import { state, terminalScrollback, modelCache } from '../../state'
import { readSettings } from '../../settings-store'
import { projectCurrentSettings, projectableSchema, projectableGroups } from '../../projectable-settings'
import { getRemoteTabStates } from '../snapshot'
import { readRemoteDisplay } from './display'

function log(msg: string): void {
  _log('main', msg)
}

/** Broadcast sync to all connected devices (used after state-changing operations). */
export async function broadcastSync(): Promise<void> {
  await sendSync((event) => state.remoteTransport?.send(event))
}

/**
 * Build a snapshot envelope and hand it to the supplied sender. The sender
 * decides whether to broadcast to all devices or send to one — that policy
 * is kept on the caller side. The body of this function is the verbatim
 * extraction of the previously-private `_sendSync` from tabs.ts.
 */
export async function sendSync(send: (event: any) => void): Promise<void> {
  const { tabs, resourceManifest } = await getRemoteTabStates()
  const syncSettings = readSettings()
  const recentDirectories: string[] = Array.isArray(syncSettings.recentBaseDirectories) ? syncSettings.recentBaseDirectories : []
  const tabGroupMode = syncSettings.tabGroupMode || 'off'
  const tabGroups = Array.isArray(syncSettings.tabGroups) ? syncSettings.tabGroups.map((g: any) => ({ id: g.id, label: g.label, isDefault: g.isDefault, order: g.order })) : []
  const remoteDisplay = readRemoteDisplay()
  log(`SNAP-SEND: tabs=${tabs.length} dirs=${recentDirectories.length} remoteDisplay=${remoteDisplay ? `name=${remoteDisplay.customName === null ? 'null' : 'set'} icon=${remoteDisplay.customIcon ?? 'null'} ts=${remoteDisplay.updatedAt}` : 'unset'}`)
  send({
    type: 'desktop_snapshot',
    tabs,
    recentDirectories,
    tabGroupMode,
    tabGroups,
    preferredModel: syncSettings.preferredModel || undefined,
    engineDefaultModel: syncSettings.engineDefaultModel || undefined,
    availableModels: modelCache.models.length > 0 ? modelCache.models : undefined,
    customName: remoteDisplay?.customName ?? undefined,
    customIcon: remoteDisplay?.customIcon ?? undefined,
    remoteDisplayUpdatedAt: remoteDisplay?.updatedAt ?? undefined,
    resources: Object.keys(resourceManifest).length > 0 ? resourceManifest : undefined,
  })
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
  send({
    type: 'desktop_settings_snapshot',
    settings: projectCurrentSettings(),
    schema: projectableSchema(),
    groups: projectableGroups(),
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
      } catch {}
    }
  }
}
