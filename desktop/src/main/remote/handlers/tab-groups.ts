/**
 * Remote handlers for tab-group operations.
 *
 * Extracted from `tabs.ts` because the file grew past its size cap. These
 * four handlers form a natural cluster: each one mutates the renderer's
 * tab-group state via executeJavaScript against the per-window store,
 * then broadcasts a sync snapshot so all remote devices see the change.
 *
 * Functions remain pure entry points keyed by `RemoteCommand` discriminant
 * — the dispatcher in transport.ts continues to route by `type`.
 */

import { log as _log } from '../../logger'
import { state } from '../../state'
import { readSettings, writeSettings } from '../../settings-store'
import { broadcastSync } from './tabs-sync'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleSetTabGroupMode(cmd: Extract<RemoteCommand, { type: 'desktop_set_tab_group_mode' }>): Promise<void> {
  const mode = cmd.mode
  if (mode !== 'auto' && mode !== 'manual' && mode !== 'off') {
    log(`Remote set_tab_group_mode: invalid mode "${mode}"`)
    return
  }
  log(`Remote set_tab_group_mode: mode=${mode}`)
  const escaped = mode.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  // Drive mode change through renderer to trigger stash/restore logic
  try {
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var prefs = window.__Ion_PREFS_STORE__;
        var session = window.__Ion_SESSION_STORE__;
        if (!prefs || !session) return;
        var oldMode = prefs.getState().tabGroupMode;
        var newMode = '${escaped}';
        if (oldMode === newMode) return;
        if (oldMode === 'manual') {
          var cg = prefs.getState().tabGroups;
          var tabs = session.getState().tabs;
          var asgn = {};
          for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].groupId) asgn[tabs[i].id] = tabs[i].groupId;
          }
          prefs.getState().setStashedManualGroups(cg, asgn);
        }
        if (newMode === 'manual' && (oldMode === 'off' || oldMode === 'auto')) {
          var sg = prefs.getState().stashedManualGroups;
          if (sg.length > 0) {
            var sa = prefs.getState().stashedManualTabAssignments;
            prefs.getState().setTabGroups(sg);
            var dg = sg.find(function(g) { return g.isDefault; }) || sg[0];
            var gids = {};
            for (var j = 0; j < sg.length; j++) gids[sg[j].id] = true;
            session.setState(function(s) {
              return { tabs: s.tabs.map(function(t) {
                var g = sa[t.id];
                if (g && gids[g]) return Object.assign({}, t, { groupId: g });
                return Object.assign({}, t, { groupId: dg.id });
              })};
            });
          } else {
            prefs.getState().setTabGroups([]);
            session.setState(function(s) {
              return { tabs: s.tabs.map(function(t) {
                return Object.assign({}, t, { groupId: null });
              })};
            });
          }
        } else if (newMode === 'auto' && oldMode === 'manual') {
          session.setState(function(s) {
            return { tabs: s.tabs.map(function(t) {
              return Object.assign({}, t, { groupId: null });
            })};
          });
        }
        prefs.getState().setTabGroupMode(newMode);
      })()
    `)
  } catch {}
  // Also persist to settings file directly for consistency
  const settings = readSettings()
  settings.tabGroupMode = mode
  writeSettings(settings)
  await broadcastSync()
}

export async function handleReorderTabGroups(cmd: Extract<RemoteCommand, { type: 'desktop_reorder_tab_groups' }>): Promise<void> {
  const ids = cmd.orderedIds
  if (!Array.isArray(ids) || ids.length === 0) {
    log('reorder_tab_groups: empty or invalid orderedIds')
    return
  }
  try {
    const escaped = JSON.stringify(ids).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var prefs = window.__Ion_PREFS_STORE__;
        if (!prefs) return;
        var orderedIds = JSON.parse('${escaped}');
        var allGroups = prefs.getState().tabGroups;
        var byId = {};
        for (var i = 0; i < allGroups.length; i++) byId[allGroups[i].id] = allGroups[i];
        var result = [];
        for (var j = 0; j < orderedIds.length; j++) {
          if (byId[orderedIds[j]]) result.push(byId[orderedIds[j]]);
        }
        // Append any groups not in the ordered list (safety net)
        var seen = {};
        for (var k = 0; k < orderedIds.length; k++) seen[orderedIds[k]] = true;
        for (var m = 0; m < allGroups.length; m++) {
          if (!seen[allGroups[m].id]) result.push(allGroups[m]);
        }
        prefs.getState().reorderTabGroups(result);
      })()
    `)
  } catch (err) {
    log('reorder_tab_groups error: ' + (err as Error).message)
  }
  await broadcastSync()
}

export async function handleMoveTabToGroup(cmd: Extract<RemoteCommand, { type: 'desktop_move_tab_to_group' }>): Promise<void> {
  try {
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedGroup = cmd.groupId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().moveTabToGroup('${escapedTab}', '${escapedGroup}');
      })()
    `)
  } catch (err) {
    log('move_tab_to_group error: ' + (err as Error).message)
  }
  await broadcastSync()
}

export async function handleToggleTabGroupPin(cmd: Extract<RemoteCommand, { type: 'desktop_toggle_tab_group_pin' }>): Promise<void> {
  try {
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().toggleTabGroupPin('${escapedTab}');
      })()
    `)
  } catch (err) {
    log('toggle_tab_group_pin error: ' + (err as Error).message)
  }
  await broadcastSync()
}
