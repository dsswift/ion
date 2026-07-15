import { log as _log } from '../../logger'
import { state, engineBridge } from '../../state'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/** Per-device voice configuration (sent by iOS). */
const deviceVoiceConfig = new Map<string, { enabled: boolean; mode: 'client' | 'desktop'; systemPrompt?: string }>()

export function handleVoiceConfig(
  cmd: Extract<RemoteCommand, { type: 'desktop_voice_config' }>,
  deviceId: string,
): void {
  log('voice_config', { device_id: deviceId, enabled: cmd.enabled, mode: cmd.mode, has_prompt: !!cmd.systemPrompt })
  deviceVoiceConfig.set(deviceId, { enabled: cmd.enabled, mode: cmd.mode, systemPrompt: cmd.systemPrompt })
}

export function getVoiceSystemPrompt(deviceId: string): string | undefined {
  const cfg = deviceVoiceConfig.get(deviceId)
  if (!cfg || !cfg.enabled || cfg.mode !== 'desktop') return undefined
  return cfg.systemPrompt
}

export function handleEngineAbort(cmd: Extract<RemoteCommand, { type: 'desktop_engine_abort' }>): void {
  const hKey = cmd.tabId
  engineBridge.sendAbort(hKey)
}

/**
 * Reset an engine instance's session to a clean state without removing
 * the instance pane. Stops the engine session keyed by bare tabId and
 * asks the renderer to wipe per-instance state Maps. Used by the
 * iOS "Implement, clear context" flow on engine tabs — the engine-instance
 * equivalent of `reset_tab_session` for the CLI session plane.
 *
 * `reset_tab_session` already exists and routes through `sessionPlane.resetTabSession`
 * (which calls `bridge.stopSession(tabId)` with bare tabId). Engine tabs use
 * the same bare tabId key, so both paths call `bridge.stopSession` with the
 * same key shape.
 */
export async function handleResetEngineSession(cmd: Extract<RemoteCommand, { type: 'desktop_reset_engine_session' }>): Promise<void> {
  const key = cmd.tabId
  log('reset_engine_session', { tab_id: cmd.tabId, key })
  await engineBridge.stopSession(key)
  log('reset_engine_session: stop complete', { key })
  // Ask the renderer to wipe its per-instance state Maps (messages,
  // status, agent-state, dialogs, etc.) and seed a fresh
  // "Session started" divider. Mirrors the IPC pattern other engine
  // handlers in this file use to mutate renderer state from main.
  try {
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedInst = cmd.instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().resetEngineInstance('${escapedTab}', '${escapedInst}');
      })()
    `)
    log('reset_engine_session: renderer state wiped', { key })
  } catch (err) {
    log('reset_engine_session: renderer wipe failed', { key, error: (err as Error).message })
  }
}

export function handleEngineDialogResponse(cmd: Extract<RemoteCommand, { type: 'desktop_engine_dialog_response' }>): void {
  const hKey = cmd.tabId
  engineBridge.sendDialogResponse(hKey, cmd.dialogId, cmd.value)
}

export async function handleEngineSetModel(cmd: Extract<RemoteCommand, { type: 'desktop_engine_set_model' }>): Promise<void> {
  try {
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedModel = cmd.model.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().setTabModel('${escapedTab}', '${escapedModel}');
      })()
    `)
  } catch (err) {
    log('engine_set_model error', { error: (err as Error).message })
  }
}
export async function handleLoadAgentConversation(cmd: Extract<RemoteCommand, { type: 'desktop_load_agent_conversation' }>, deviceId: string): Promise<void> {
  try {
    log('load_agent_conversation', { conversation_ids: cmd.conversationIds.join(',') })
    if (!engineBridge || cmd.conversationIds.length === 0) {
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_agent_conversation_history', agentName: '', messages: [] })
      return
    }

    const allMessages: Array<{ id: string; role: string; content: string; toolName?: string; toolId?: string; toolStatus?: string; timestamp: number }> = []
    for (const convId of cmd.conversationIds) {
      try {
        const data = await engineBridge.getConversation(convId, 0, 0)
        const msgs = data.messages || []
        for (const m of msgs) {
          let content = m.content || ''
          // Truncate tool result content at 2KB to keep wire size manageable.
          // User, assistant, and harness messages are never truncated.
          if (m.role === 'tool' && content.length > 2048) {
            content = content.substring(0, 2048) + '\n... [truncated]'
          }
          allMessages.push({
            id: m.id || '',
            role: m.role || 'system',
            content,
            toolName: m.toolName,
            toolId: m.toolId,
            toolStatus: m.toolStatus,
            timestamp: m.timestamp || 0,
          })
        }
      } catch (convErr) {
        log('load_agent_conversation: failed to load', { conversation_id: convId, error: (convErr as Error).message })
      }
    }

    // Resolve the agent name from the renderer's agent state so the iOS
    // client can key the response. Each dispatch now has a distinct
    // conversationId, so no message slicing is needed.
    let agentName = ''
    if (state.mainWindow) {
      try {
        const convIdsJson = JSON.stringify(cmd.conversationIds)
        const result = await state.mainWindow.webContents.executeJavaScript(`
          (function() {
            var store = window.__Ion_SESSION_STORE__;
            if (!store) return { name: '' };
            var convIds = ${convIdsJson};
            var conversationPanes = store.getState().conversationPanes;
            for (var [, pane] of conversationPanes) {
              for (var inst of pane.instances) {
                var agents = inst.agentStates || [];
                for (var a of agents) {
                  var meta = a.metadata || {};
                  var dispatches = meta.dispatches || [];
                  for (var d of dispatches) {
                    for (var cid of convIds) {
                      if (d.conversationId === cid) return { name: a.name };
                    }
                  }
                  var aConvId = meta.conversationId || '';
                  var aConvIds = meta.conversationIds || [];
                  for (var cid of convIds) {
                    if (cid === aConvId || aConvIds.indexOf(cid) >= 0) return { name: a.name };
                  }
                }
              }
            }
            return { name: '' };
          })()
        `)
        agentName = result?.name || ''
      } catch {
        // Best-effort name resolution; empty string is fine
      }
    }

    log('load_agent_conversation: resolved', { agent_name: agentName || '', total_messages: allMessages.length })

    const finalMessages = allMessages

    // Echo back the conversationId when loading a single dispatch so the
    // iOS client can cache per-dispatch conversations independently.
    const singleConvId = cmd.conversationIds.length === 1 ? cmd.conversationIds[0] : undefined
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_agent_conversation_history', agentName, conversationId: singleConvId, messages: finalMessages })
  } catch (err) {
    log('load_agent_conversation error', { error: (err as Error).message })
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_agent_conversation_history', agentName: '', messages: [] })
  }
}
