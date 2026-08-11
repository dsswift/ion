import { IPC } from '../../../shared/types'
import { log as _log } from '../../logger'
import { state, terminalScrollback } from '../../state'
import { broadcast } from '../../broadcast'
import { terminalManager } from '../../terminal-manager-instance'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

export function handleTerminalInput(cmd: Extract<RemoteCommand, { type: 'desktop_terminal_input' }>): void {
  const key = `${cmd.tabId}:${cmd.instanceId}`
  terminalManager.write(key, cmd.data)
}

export function handleTerminalResize(cmd: Extract<RemoteCommand, { type: 'desktop_terminal_resize' }>): void {
  const key = `${cmd.tabId}:${cmd.instanceId}`
  terminalManager.resize(key, cmd.cols, cmd.rows)
}

/**
 * Create a terminal instance on a NAMED tab and start its PTY.
 *
 * Shared by the iOS `desktop_terminal_add_instance` command and the `ion://`
 * deep-link terminal action, so both get identical semantics rather than two
 * drifting implementations.
 *
 * Three properties matter and each is a fix for a real defect:
 *
 *  1. **The pane is marked OPEN.** This used to write `terminalPanes` only, so
 *     a tab ended up holding instances the panel did not render until the
 *     operator manually toggled the terminal — output streaming into a pane
 *     nobody could see.
 *  2. **The tab is resolved strictly by id, never by "active".** Returns
 *     `null` when `tabId` names no live tab so the caller can refuse. Silently
 *     retargeting the active tab is the stray-pane failure the deep-link
 *     surface exists to prevent: `dev run` in conversation A's shell must put
 *     its panes in A even when the operator has navigated to B.
 *  3. **Focus is not stolen.** The new instance becomes active WITHIN its own
 *     pane, but `activeTabId` is untouched, so a pane opening in a background
 *     conversation does not yank the operator out of the one they are reading.
 *
 * `label` is optional. When given (a deep link naming a service, e.g. `api`)
 * it replaces the auto-numbered `Shell N`; when absent the store's existing
 * numbering applies, which is what the iOS caller relies on.
 *
 * Returns the created instance, or `null` when the renderer store is
 * unavailable or the tab does not exist.
 */
export async function createTerminalInstanceOnTab(
  tabId: string,
  opts: { label?: string } = {},
): Promise<{ id: string; label: string; kind: string; cwd: string } | null> {
  const escaped = JSON.stringify(tabId)
  const escapedLabel = opts.label ? JSON.stringify(opts.label) : 'null'
  const result = await state.mainWindow?.webContents.executeJavaScript(`
    (function() {
      var store = window.__Ion_SESSION_STORE__;
      if (!store) return null;
      var s = store.getState();
      // Resolve by id only. No fallback to the active tab: a caller that names
      // a dead tab must be refused, not silently redirected.
      if (!s.tabs.some(function(t) { return t.id === ${escaped}; })) return 'no-such-tab';
      var id = s.addTerminalInstance(${escaped}, 'user');
      var label = ${escapedLabel};
      if (label) s.renameTerminalInstance(${escaped}, id, label);
      // Mark the pane open so the panel actually renders it, and select the new
      // instance within that pane. activeTabId is deliberately NOT changed.
      var nextOpen = new Set(store.getState().terminalOpenTabIds);
      nextOpen.add(${escaped});
      store.setState({ terminalOpenTabIds: nextOpen });
      store.getState().selectTerminalInstance(${escaped}, id);
      var pane = store.getState().terminalPanes.get(${escaped});
      if (!pane) return null;
      var inst = pane.instances.find(function(i) { return i.id === id; });
      if (!inst) return null;
      return { id: inst.id, label: inst.label, kind: inst.kind, cwd: inst.cwd || '' };
    })()
  `)
  if (result === 'no-such-tab') {
    log('terminal_add_instance refused: no such tab', { tabId })
    return null
  }
  if (!result) {
    log('terminal_add_instance failed: renderer store unavailable', { tabId })
    return null
  }
  terminalManager.create(`${tabId}:${result.id}`, result.cwd || '~')
  log('terminal_add_instance created', { tabId, instanceId: result.id, label: result.label })
  return result
}

export async function handleTerminalAddInstance(cmd: Extract<RemoteCommand, { type: 'desktop_terminal_add_instance' }>): Promise<void> {
  try {
    const result = await createTerminalInstanceOnTab(cmd.tabId)
    if (result) {
      state.remoteTransport?.send({
        type: 'desktop_terminal_instance_added',
        tabId: cmd.tabId,
        instance: { id: result.id, label: result.label || 'Shell', kind: result.kind || 'user', readOnly: false, cwd: result.cwd || '' },
      })
    }
  } catch (err) {
    log('terminal_add_instance error', { error: (err as Error).message })
  }
}

export async function handleTerminalRemoveInstance(cmd: Extract<RemoteCommand, { type: 'desktop_terminal_remove_instance' }>): Promise<void> {
  try {
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedInst = cmd.instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().removeTerminalInstance('${escapedTab}', '${escapedInst}');
      })()
    `)
    terminalManager.destroy(`${cmd.tabId}:${cmd.instanceId}`)
    state.remoteTransport?.send({ type: 'desktop_terminal_instance_removed', tabId: cmd.tabId, instanceId: cmd.instanceId })
  } catch (err) {
    log('terminal_remove_instance error', { error: (err as Error).message })
  }
}

export async function handleRequestTerminalSnapshot(cmd: Extract<RemoteCommand, { type: 'desktop_request_terminal_snapshot' }>, deviceId: string): Promise<void> {
  try {
    const escapedTabId = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const tabState = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var pane = store.getState().terminalPanes.get('${escapedTabId}');
          if (!pane) return null;
          var instances = pane.instances.map(function(inst) {
            return { id: inst.id, label: inst.label || inst.id, kind: inst.kind || 'user', readOnly: !!inst.readOnly, cwd: inst.cwd || '' };
          });
          var buffers = {};
          for (var i = 0; i < pane.instances.length; i++) {
            var key = '${escapedTabId}:' + pane.instances[i].id;
            var buf = window.__serializeTerminalBuffer ? window.__serializeTerminalBuffer(key) : null;
            if (buf) buffers[pane.instances[i].id] = buf;
          }
          return { instances: instances, activeInstanceId: pane.activeInstanceId || null, buffers: buffers };
        } catch(e) { return null; }
      })()
    `)
    if (tabState) {
      log('request_terminal_snapshot pane found', { tabId: cmd.tabId, instanceCount: tabState.instances.length })
      // Fall back to main-process scrollback for instances where the renderer
      // doesn't have an xterm instance (e.g. terminal tabs created from iOS
      // that the desktop user has never navigated to).
      const buffers = { ...tabState.buffers }
      for (const inst of tabState.instances) {
        if (!buffers[inst.id]) {
          const scrollback = terminalScrollback.get(`${cmd.tabId}:${inst.id}`)
          if (scrollback) buffers[inst.id] = scrollback
        }
      }
      state.remoteTransport?.sendToDevice(deviceId, {
        type: 'desktop_terminal_snapshot',
        tabId: cmd.tabId,
        instances: tabState.instances,
        activeInstanceId: tabState.activeInstanceId,
        buffers: Object.keys(buffers).length > 0 ? buffers : undefined,
      })
      return
    }
    // No pane exists for this tab — the desktop user has never opened the
    // terminal panel locally, so the renderer store has no terminalPanes
    // entry. Mirror what TerminalPanel.tsx does on first mount: auto-create
    // the default "Shell" instance (kind 'user'). The renderer's
    // addTerminalInstance resolves cwd from the tab's workingDirectory
    // (falling back to '~'), exactly as handleTerminalAddInstance relies on.
    const created = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var id = store.getState().addTerminalInstance('${escapedTabId}', 'user');
        var pane = store.getState().terminalPanes.get('${escapedTabId}');
        if (!pane) return null;
        var inst = pane.instances.find(function(i) { return i.id === id; });
        if (!inst) return null;
        return { id: inst.id, label: inst.label, kind: inst.kind, cwd: inst.cwd || '' };
      })()
    `)
    if (created) {
      const key = `${cmd.tabId}:${created.id}`
      terminalManager.create(key, created.cwd || '~')
      log('request_terminal_snapshot pane missing, auto-created default instance', {
        tabId: cmd.tabId,
        instanceId: created.id,
        cwd: created.cwd || '~',
      })
      state.remoteTransport?.sendToDevice(deviceId, {
        type: 'desktop_terminal_snapshot',
        tabId: cmd.tabId,
        instances: [{ id: created.id, label: created.label || 'Shell', kind: created.kind || 'user', readOnly: false, cwd: created.cwd || '' }],
        activeInstanceId: created.id,
        buffers: undefined,
      })
    } else {
      log('request_terminal_snapshot pane missing and auto-create failed (renderer store unavailable)', { tabId: cmd.tabId })
    }
  } catch (err) {
    log('request_terminal_snapshot error', { error: (err as Error).message })
  }
}

export async function handleTerminalSelectInstance(cmd: Extract<RemoteCommand, { type: 'desktop_terminal_select_instance' }>): Promise<void> {
  try {
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedInst = cmd.instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().selectTerminalInstance('${escapedTab}', '${escapedInst}');
      })()
    `)
  } catch (err) {
    log('terminal_select_instance error', { error: (err as Error).message })
  }
}

export function handleRenameTab(cmd: Extract<RemoteCommand, { type: 'desktop_rename_tab' }>): void {
  broadcast(IPC.REMOTE_RENAME_TAB, cmd.tabId, cmd.customTitle)
}

export function handleRenameTerminalInstance(cmd: Extract<RemoteCommand, { type: 'desktop_rename_terminal_instance' }>): void {
  broadcast(IPC.REMOTE_RENAME_TERMINAL_INSTANCE, cmd.tabId, cmd.instanceId, cmd.label)
}

export function handleSetPillColor(cmd: Extract<RemoteCommand, { type: 'desktop_set_pill_color' }>): void {
  broadcast(IPC.REMOTE_SET_PILL_COLOR, cmd.tabId, cmd.pillColor)
}

export function handleSetPillIcon(cmd: Extract<RemoteCommand, { type: 'desktop_set_pill_icon' }>): void {
  broadcast(IPC.REMOTE_SET_PILL_ICON, cmd.tabId, cmd.pillIcon)
}
