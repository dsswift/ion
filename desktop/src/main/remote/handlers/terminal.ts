import { IPC } from '../../../shared/types'
import { log as _log } from '../../logger'
import { state } from '../../state'
import { broadcast } from '../../broadcast'
import { terminalManager } from '../../terminal-manager-instance'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

export function handleTerminalInput(cmd: Extract<RemoteCommand, { type: 'terminal_input' }>): void {
  const key = `${cmd.tabId}:${cmd.instanceId}`
  terminalManager.write(key, cmd.data)
}

export function handleTerminalResize(cmd: Extract<RemoteCommand, { type: 'terminal_resize' }>): void {
  const key = `${cmd.tabId}:${cmd.instanceId}`
  terminalManager.resize(key, cmd.cols, cmd.rows)
}

export async function handleTerminalAddInstance(cmd: Extract<RemoteCommand, { type: 'terminal_add_instance' }>): Promise<void> {
  try {
    const escaped = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const result = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        return store.getState().addTerminalInstance('${escaped}', 'user');
      })()
    `)
    if (result) {
      state.remoteTransport?.send({
        type: 'terminal_instance_added',
        tabId: cmd.tabId,
        instance: { id: result.id, label: result.label || 'Shell', kind: result.kind || 'user', readOnly: false, cwd: result.cwd || '' },
      })
    }
  } catch (err) {
    log(`terminal_add_instance error: ${(err as Error).message}`)
  }
}

export async function handleTerminalRemoveInstance(cmd: Extract<RemoteCommand, { type: 'terminal_remove_instance' }>): Promise<void> {
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
    state.remoteTransport?.send({ type: 'terminal_instance_removed', tabId: cmd.tabId, instanceId: cmd.instanceId })
  } catch (err) {
    log(`terminal_remove_instance error: ${(err as Error).message}`)
  }
}

export async function handleRequestTerminalSnapshot(cmd: Extract<RemoteCommand, { type: 'request_terminal_snapshot' }>): Promise<void> {
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
      state.remoteTransport?.send({
        type: 'terminal_snapshot',
        tabId: cmd.tabId,
        instances: tabState.instances,
        activeInstanceId: tabState.activeInstanceId,
        buffers: Object.keys(tabState.buffers).length > 0 ? tabState.buffers : undefined,
      })
    }
  } catch (err) {
    log(`request_terminal_snapshot error: ${(err as Error).message}`)
  }
}

export async function handleTerminalSelectInstance(cmd: Extract<RemoteCommand, { type: 'terminal_select_instance' }>): Promise<void> {
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
    log(`terminal_select_instance error: ${(err as Error).message}`)
  }
}

export function handleRenameTab(cmd: Extract<RemoteCommand, { type: 'rename_tab' }>): void {
  broadcast(IPC.REMOTE_RENAME_TAB, cmd.tabId, cmd.customTitle)
}

export function handleRenameTerminalInstance(cmd: Extract<RemoteCommand, { type: 'rename_terminal_instance' }>): void {
  broadcast(IPC.REMOTE_RENAME_TERMINAL_INSTANCE, cmd.tabId, cmd.instanceId, cmd.label)
}
