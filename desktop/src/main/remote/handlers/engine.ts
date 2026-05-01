import { log as _log } from '../../logger'
import { state, engineBridge } from '../../state'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

export function handleEnginePrompt(cmd: Extract<RemoteCommand, { type: 'engine_prompt' }>): void {
  const hKey = cmd.instanceId ? `${cmd.tabId}:${cmd.instanceId}` : cmd.tabId
  engineBridge.sendPrompt(hKey, cmd.text)
}

export function handleEngineAbort(cmd: Extract<RemoteCommand, { type: 'engine_abort' }>): void {
  const hKey = cmd.instanceId ? `${cmd.tabId}:${cmd.instanceId}` : cmd.tabId
  engineBridge.sendAbort(hKey)
}

export function handleEngineDialogResponse(cmd: Extract<RemoteCommand, { type: 'engine_dialog_response' }>): void {
  const hKey = cmd.instanceId ? `${cmd.tabId}:${cmd.instanceId}` : cmd.tabId
  engineBridge.sendDialogResponse(hKey, cmd.dialogId, cmd.value)
}

export async function handleEngineAddInstance(cmd: Extract<RemoteCommand, { type: 'engine_add_instance' }>): Promise<void> {
  try {
    const escaped = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const instanceId = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        return store.getState().addEngineInstance('${escaped}');
      })()
    `)
    if (instanceId) {
      const instanceInfo = await state.mainWindow?.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var pane = store.getState().enginePanes.get('${escaped}');
          if (!pane) return null;
          var escapedId = '${instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';
          var inst = pane.instances.find(function(i) { return i.id === escapedId; });
          return inst ? { id: inst.id, label: inst.label } : null;
        })()
      `)
      if (instanceInfo) {
        state.remoteTransport?.send({
          type: 'engine_instance_added',
          tabId: cmd.tabId,
          instance: instanceInfo,
        })
      }
    }
  } catch (err) {
    log(`engine_add_instance error: ${(err as Error).message}`)
  }
}

export async function handleEngineRemoveInstance(cmd: Extract<RemoteCommand, { type: 'engine_remove_instance' }>): Promise<void> {
  try {
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedInst = cmd.instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().removeEngineInstance('${escapedTab}', '${escapedInst}');
      })()
    `)
    state.remoteTransport?.send({ type: 'engine_instance_removed', tabId: cmd.tabId, instanceId: cmd.instanceId })
  } catch (err) {
    log(`engine_remove_instance error: ${(err as Error).message}`)
  }
}

export async function handleEngineSelectInstance(cmd: Extract<RemoteCommand, { type: 'engine_select_instance' }>): Promise<void> {
  try {
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedInst = cmd.instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().selectEngineInstance('${escapedTab}', '${escapedInst}');
      })()
    `)
  } catch (err) {
    log(`engine_select_instance error: ${(err as Error).message}`)
  }
}

export async function handleLoadEngineConversation(cmd: Extract<RemoteCommand, { type: 'load_engine_conversation' }>): Promise<void> {
  try {
    log(`load_engine_conversation: tabId=${cmd.tabId}, instanceId=${cmd.instanceId || 'null'}`)
    if (!state.mainWindow) {
      state.remoteTransport?.send({ type: 'engine_conversation_history', tabId: cmd.tabId, instanceId: cmd.instanceId || null, messages: [] })
      return
    }
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const compoundKey = cmd.instanceId
      ? `${cmd.tabId}:${cmd.instanceId}`
      : await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return '${escapedTab}';
          var pane = store.getState().enginePanes.get('${escapedTab}');
          return pane && pane.activeInstanceId ? '${escapedTab}:' + pane.activeInstanceId : '${escapedTab}';
        })()
      `) || cmd.tabId
    const escapedKey = compoundKey.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const msgs = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return [];
        var msgs = store.getState().engineMessages.get('${escapedKey}') || [];
        return msgs.map(function(m) {
          var content = m.content || '';
          if (m.role === 'tool' && content.length > 2048) content = content.substring(0, 2048) + '\\n... [truncated]';
          else if (content.length > 10000) content = content.substring(0, 10000);
          return { id: m.id, role: m.role, content: content, toolName: m.toolName, toolId: m.toolId, toolStatus: m.toolStatus, timestamp: m.timestamp };
        });
      })()
    `) || []
    const instanceId = compoundKey.includes(':') ? compoundKey.split(':')[1] : null
    log(`load_engine_conversation: compoundKey=${compoundKey}, found ${msgs.length} messages, instanceId=${instanceId}`)
    state.remoteTransport?.send({ type: 'engine_conversation_history', tabId: cmd.tabId, instanceId, messages: msgs })
  } catch (err) {
    log(`load_engine_conversation error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'engine_conversation_history', tabId: cmd.tabId, instanceId: cmd.instanceId || null, messages: [] })
  }
}
