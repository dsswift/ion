import { IPC } from '../../../shared/types'
import { log as _log } from '../../logger'
import { state, engineBridge } from '../../state'
import { broadcast } from '../../broadcast'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleEnginePrompt(cmd: Extract<RemoteCommand, { type: 'engine_prompt' }>): Promise<void> {
  try {
    if (!state.mainWindow) {
      log('engine_prompt: no mainWindow, ignoring')
      return
    }
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

    // Resolve the active instance from the renderer store.
    // If no instance exists yet (EngineView hasn't mounted), create one.
    let instanceId: string | null = cmd.instanceId || await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var pane = store.getState().enginePanes.get('${escapedTab}');
        return pane && pane.activeInstanceId ? pane.activeInstanceId : null;
      })()
    `)

    if (!instanceId) {
      log('engine_prompt: no instance exists, auto-creating one')
      instanceId = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          return store.getState().addEngineInstance('${escapedTab}');
        })()
      `)
      if (!instanceId) {
        log('engine_prompt: failed to create engine instance')
        return
      }
      // Notify iOS about the new instance
      const instanceInfo = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var pane = store.getState().enginePanes.get('${escapedTab}');
          if (!pane) return null;
          var inst = pane.instances.find(function(i) { return i.id === '${instanceId!.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'; });
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
      // Wait for the engine session to initialise before sending the prompt
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    // Route through the renderer's submitEnginePrompt so it adds the user
    // message, sets tab status, and calls the engine bridge properly.
    broadcast(IPC.REMOTE_ENGINE_PROMPT, { tabId: cmd.tabId, text: cmd.text })
  } catch (err) {
    log(`engine_prompt error: ${(err as Error).message}`)
  }
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

    // Also send current engine state so iOS has agent panel, status bar,
    // and working message even when connecting to an already-running session.
    await sendCurrentEngineState(cmd.tabId, instanceId, escapedKey)
  } catch (err) {
    log(`load_engine_conversation error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'engine_conversation_history', tabId: cmd.tabId, instanceId: cmd.instanceId || null, messages: [] })
  }
}

/** Push the latest agent state, status fields, and working message for a compound key. */
async function sendCurrentEngineState(tabId: string, instanceId: string | null, escapedKey: string): Promise<void> {
  if (!state.mainWindow || !state.remoteTransport) return
  try {
    const snapshot = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var s = store.getState();
        var key = '${escapedKey}';
        var agents = s.engineAgentStates.get(key) || [];
        var status = s.engineStatusFields.get(key) || null;
        var working = s.engineWorkingMessages.get(key) || '';
        return { agents: agents, status: status, working: working };
      })()
    `)
    if (!snapshot) return

    if (snapshot.agents && snapshot.agents.length > 0) {
      state.remoteTransport.send({
        type: 'engine_agent_state', tabId, instanceId, agents: snapshot.agents,
      })
    }
    if (snapshot.status) {
      state.remoteTransport.send({
        type: 'engine_status', tabId, instanceId, fields: snapshot.status,
      })
    }
    if (snapshot.working) {
      state.remoteTransport.send({
        type: 'engine_working_message', tabId, instanceId, message: snapshot.working,
      })
    }
  } catch (err) {
    log(`sendCurrentEngineState error: ${(err as Error).message}`)
  }
}
