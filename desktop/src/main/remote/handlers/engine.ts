import { log as _log } from '../../logger'
import { state, engineBridge } from '../../state'
import { encodeImageAttachments } from '../attachment-encoder'
import { processIncomingPrompt } from '../../prompt-pipeline'
import { readEngineHistoryFromStore } from './engine-history'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

/** Per-device voice configuration (sent by iOS). */
const deviceVoiceConfig = new Map<string, { enabled: boolean; mode: 'client' | 'desktop'; systemPrompt?: string }>()

export function handleVoiceConfig(
  cmd: Extract<RemoteCommand, { type: 'desktop_voice_config' }>,
  deviceId: string,
): void {
  log(`voice_config: device=${deviceId} enabled=${cmd.enabled} mode=${cmd.mode} hasPrompt=${!!cmd.systemPrompt}`)
  deviceVoiceConfig.set(deviceId, { enabled: cmd.enabled, mode: cmd.mode, systemPrompt: cmd.systemPrompt })
}

export function getVoiceSystemPrompt(deviceId: string): string | undefined {
  const cfg = deviceVoiceConfig.get(deviceId)
  if (!cfg || !cfg.enabled || cfg.mode !== 'desktop') return undefined
  return cfg.systemPrompt
}

export async function handleEnginePrompt(cmd: Extract<RemoteCommand, { type: 'desktop_engine_prompt' }>, deviceId: string): Promise<void> {
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
        var pane = store.getState().conversationPanes.get('${escapedTab}');
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
          var pane = store.getState().conversationPanes.get('${escapedTab}');
          if (!pane) return null;
          var inst = pane.instances.find(function(i) { return i.id === '${instanceId!.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'; });
          return inst ? { id: inst.id, label: inst.label } : null;
        })()
      `)
      if (instanceInfo) {
        state.remoteTransport?.send({
          type: 'desktop_instance_added',
          tabId: cmd.tabId,
          instance: instanceInfo,
        })
      }
      // Send the initial model override so iOS knows the configured model
      const escapedInstId = instanceId!.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const modelOverride = await state.mainWindow.webContents.executeJavaScript(
        `window.__Ion_resolveEngineModel('${escapedTab}:${escapedInstId}')`
      )
      if (modelOverride) {
        state.remoteTransport?.send({
          type: 'desktop_model_override',
          tabId: cmd.tabId,
          instanceId,
          model: modelOverride,
        })
      }
      // Wait for the engine session to initialise before sending the prompt
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    // Hand off to the unified prompt pipeline. The pipeline owns the full
    // decision tree (slash → extension command → .md → unknown-command,
    // or normal prompt). Routing is no longer duplicated in
    // slash-intercept.ts; both CLI and engine entry points share the same
    // policy. For normal prompts the pipeline broadcasts REMOTE_ENGINE_PROMPT
    // so the renderer's submitEnginePrompt does the optimistic insert and
    // calls the engine bridge.
    //
    // Image-attachment encoding happens INSIDE the pipeline for CLI; for
    // engine tabs we pre-encode here because the engine bridge takes
    // already-encoded ImageAttachmentPayload[] and the broadcast envelope
    // mirrors that shape. Attachment-context lines are still prepended here
    // for engine consistency with the prior behaviour.
    let fullText = cmd.text
    const attachments = cmd.attachments || []
    if (attachments.length > 0) {
      const ctx = attachments.map((a) => `[Attached ${a.type}: ${a.path}]`).join('\n')
      fullText = `${ctx}\n\n${fullText}`
    }
    const { encoded, rewrittenText } = encodeImageAttachments(fullText, attachments)
    const voicePrompt = getVoiceSystemPrompt(deviceId)
    const reqId = `remote-engine-${Date.now()}`

    // Resolve the tab's working directory from the renderer store so the
    // pipeline can find project-scoped `.md` templates. Mirrors the same
    // query in tabs.ts:resolveTabProjectPath — duplicated inline here to
    // avoid a cross-file import for one query. Engine tabs use the same
    // `tab.workingDirectory` field as CLI tabs.
    let projectPath: string | undefined
    try {
      const escapedTabForPath = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const cwd = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTabForPath}'; });
          return tab && tab.workingDirectory ? tab.workingDirectory : null;
        })()
      `)
      projectPath = cwd || undefined
    } catch (err) {
      log(`engine_prompt: project-path query failed for tab=${cmd.tabId}: ${(err as Error).message}`)
    }

    // Resolve planFilePath from the renderer store so the engine can
    // restore the plan file after a session restart instead of
    // allocating a fresh slug. Same executeJavaScript pattern as
    // projectPath above.
    let planFilePath: string | undefined
    try {
      const escapedTabForPlan = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const pfp = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTabForPlan}'; });
          return tab && tab.planFilePath ? tab.planFilePath : null;
        })()
      `)
      planFilePath = pfp || undefined
    } catch (err) {
      log(`engine_prompt: planFilePath query failed for tab=${cmd.tabId}: ${(err as Error).message}`)
    }

    await processIncomingPrompt({
      tabId: cmd.tabId,
      text: rewrittenText,
      attachments,
      imageAttachments: encoded.length > 0 ? encoded : undefined,
      reqId,
      source: 'remote',
      isEngineTab: true,
      instanceId,
      appendSystemPrompt: voicePrompt,
      projectPath,
      implementationPhase: cmd.implementationPhase,
      planFilePath,
    })
  } catch (err) {
    log(`engine_prompt error: ${(err as Error).message}`)
  }
}

export function handleEngineAbort(cmd: Extract<RemoteCommand, { type: 'desktop_engine_abort' }>): void {
  const hKey = cmd.instanceId ? `${cmd.tabId}:${cmd.instanceId}` : cmd.tabId
  engineBridge.sendAbort(hKey)
}

/**
 * Reset an engine instance's session to a clean state without removing
 * the instance pane. Stops the engine session keyed by `${tabId}:${instanceId}`
 * and asks the renderer to wipe per-instance state Maps. Used by the
 * iOS "Implement, clear context" flow on engine tabs — the engine-instance
 * equivalent of `reset_tab_session` for the CLI session plane.
 *
 * `reset_tab_session` already exists and routes through `sessionPlane.resetTabSession`
 * (which calls `bridge.stopSession(tabId)` with bare tabId). For engine
 * tabs the engine session is keyed by the compound `${tabId}:${instanceId}`,
 * so bare-tabId stop is silently a no-op. This handler closes that gap.
 */
export async function handleResetEngineSession(cmd: Extract<RemoteCommand, { type: 'desktop_reset_engine_session' }>): Promise<void> {
  const key = `${cmd.tabId}:${cmd.instanceId}`
  log(`reset_engine_session: tabId=${cmd.tabId} instanceId=${cmd.instanceId} key=${key}`)
  // Stop the engine session at the wire level. Same primitive
  // engine-control-plane.resetTabSession uses for the CLI plane.
  await engineBridge.stopSession(key)
  log(`reset_engine_session: stopSession complete key=${key}`)
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
    log(`reset_engine_session: renderer state wiped key=${key}`)
  } catch (err) {
    log(`reset_engine_session: renderer wipe failed key=${key} err=${(err as Error).message}`)
  }
}

export function handleEngineDialogResponse(cmd: Extract<RemoteCommand, { type: 'desktop_engine_dialog_response' }>): void {
  const hKey = cmd.instanceId ? `${cmd.tabId}:${cmd.instanceId}` : cmd.tabId
  engineBridge.sendDialogResponse(hKey, cmd.dialogId, cmd.value)
}

export async function handleEngineAddInstance(cmd: Extract<RemoteCommand, { type: 'desktop_engine_add_instance' }>): Promise<void> {
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
          var pane = store.getState().conversationPanes.get('${escaped}');
          if (!pane) return null;
          var escapedId = '${instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';
          var inst = pane.instances.find(function(i) { return i.id === escapedId; });
          return inst ? { id: inst.id, label: inst.label } : null;
        })()
      `)
      if (instanceInfo) {
        state.remoteTransport?.send({
          type: 'desktop_instance_added',
          tabId: cmd.tabId,
          instance: instanceInfo,
        })
        // Send the initial model override so iOS knows the configured model
        const escapedKey = `${escaped}:${instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}`
        const modelOverride = await state.mainWindow?.webContents.executeJavaScript(
          `window.__Ion_resolveEngineModel('${escapedKey}')`
        )
        if (modelOverride) {
          state.remoteTransport?.send({
            type: 'desktop_model_override',
            tabId: cmd.tabId,
            instanceId,
            model: modelOverride,
          })
        }
      }
    }
  } catch (err) {
    log(`engine_add_instance error: ${(err as Error).message}`)
  }
}

export async function handleEngineRemoveInstance(cmd: Extract<RemoteCommand, { type: 'desktop_engine_remove_instance' }>): Promise<void> {
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
    state.remoteTransport?.send({ type: 'desktop_instance_removed', tabId: cmd.tabId, instanceId: cmd.instanceId })
  } catch (err) {
    log(`engine_remove_instance error: ${(err as Error).message}`)
  }
}

export async function handleEngineMoveInstance(cmd: Extract<RemoteCommand, { type: 'desktop_engine_move_instance' }>): Promise<void> {
  try {
    log(`engine_move_instance: ${cmd.sourceTabId}:${cmd.instanceId} -> ${cmd.targetTabId}`)
    const escapedSrc = cmd.sourceTabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedInst = cmd.instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedTgt = cmd.targetTabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().moveEngineInstance('${escapedSrc}', '${escapedInst}', '${escapedTgt}');
      })()
    `)
    state.remoteTransport?.send({
      type: 'desktop_instance_moved',
      sourceTabId: cmd.sourceTabId,
      instanceId: cmd.instanceId,
      targetTabId: cmd.targetTabId,
    })
  } catch (err) {
    log(`engine_move_instance error: ${(err as Error).message}`)
  }
}

export async function handleEngineSelectInstance(cmd: Extract<RemoteCommand, { type: 'desktop_engine_select_instance' }>): Promise<void> {
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

export async function handleEngineSetModel(cmd: Extract<RemoteCommand, { type: 'desktop_engine_set_model' }>): Promise<void> {
  try {
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedModel = cmd.model.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().setEngineModel('${escapedTab}', '${escapedModel}');
      })()
    `)
  } catch (err) {
    log(`engine_set_model error: ${(err as Error).message}`)
  }
}

export async function handleLoadEngineConversation(cmd: Extract<RemoteCommand, { type: 'desktop_load_engine_conversation' }>, deviceId: string): Promise<void> {
  try {
    log(`load_engine_conversation: tabId=${cmd.tabId}, instanceId=${cmd.instanceId || 'null'}`)
    if (!state.mainWindow) {
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_engine_conversation_history', tabId: cmd.tabId, instanceId: cmd.instanceId || null, messages: [] })
      return
    }
    const { instanceId, messages: msgs, escapedKey } = await readEngineHistoryFromStore(cmd.tabId, cmd.instanceId || null)
    log(`load_engine_conversation: tabId=${cmd.tabId} found ${msgs.length} messages, instanceId=${instanceId}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_engine_conversation_history', tabId: cmd.tabId, instanceId, messages: msgs })

    // Also send current engine state so iOS has agent panel, status bar,
    // and working message even when connecting to an already-running session.
    await sendCurrentEngineState(cmd.tabId, instanceId, escapedKey)
  } catch (err) {
    log(`load_engine_conversation error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_engine_conversation_history', tabId: cmd.tabId, instanceId: cmd.instanceId || null, messages: [] })
  }
}

/**
 * Push the latest agent state, status fields, and working message for a
 * compound key to the remote transport. Called on iOS reconnect /
 * conversation load so the mobile client overwrites any stale local state.
 *
 * Engine contract: `engine_agent_state` is a complete snapshot. The
 * authoritative truth is "what the renderer holds right now" — including
 * the empty case. We forward unconditionally: an empty `agents: []`
 * payload is just as important to send as a populated one, because it
 * tells the mobile client "drop your stale rows from a previous session."
 * Without this, iOS reconnects show ghost agents from connections ago.
 * See docs/architecture/agent-state.md.
 */
async function sendCurrentEngineState(tabId: string, instanceId: string | null, escapedKey: string): Promise<void> {
  if (!state.mainWindow || !state.remoteTransport) return
  try {
    const snapshot = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var s = store.getState();
        var key = '${escapedKey}';
        var parts = key.split(':');
        var tabId = parts[0]; var instId = parts[1];
        var pane = s.conversationPanes.get(tabId);
        var inst = pane && instId ? pane.instances.find(function(i) { return i.id === instId; }) : null;
        var agents = (inst && inst.agentStates) || [];
        var status = (inst && inst.statusFields) || null;
        var working = s.engineWorkingMessages.get(key) || '';
        var modelOverride = window.__Ion_resolveEngineModel(key);
        return { agents: agents, status: status, working: working, modelOverride: modelOverride };
      })()
    `)
    if (!snapshot) {
      log(`sendCurrentEngineState: no snapshot available key=${escapedKey}`)
      return
    }

    const agents = snapshot.agents || []
    log(`sendCurrentEngineState: key=${escapedKey} agents=${agents.length} status=${!!snapshot.status} working=${snapshot.working ? 'present' : 'empty'} modelOverride=${snapshot.modelOverride ? 'present' : 'none'}`)

    // Always send the authoritative agent snapshot — including empty.
    state.remoteTransport.send({
      type: 'desktop_agent_state', tabId, instanceId, agents,
    })

    if (snapshot.status) {
      state.remoteTransport.send({
        type: 'desktop_status', tabId, instanceId, fields: snapshot.status,
      })
    }
    // Always forward working message (use '' to clear stale banner on resync).
    state.remoteTransport.send({
      type: 'desktop_working_message', tabId, instanceId, message: snapshot.working || '',
    })
    if (snapshot.modelOverride) {
      state.remoteTransport.send({
        type: 'desktop_model_override', tabId, instanceId, model: snapshot.modelOverride,
      })
    }
  } catch (err) {
    log(`sendCurrentEngineState error: ${(err as Error).message}`)
  }
}

export async function handleLoadAgentConversation(cmd: Extract<RemoteCommand, { type: 'desktop_load_agent_conversation' }>, deviceId: string): Promise<void> {
  try {
    log(`load_agent_conversation: conversationIds=${cmd.conversationIds.join(',')}`)
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
        log(`load_agent_conversation: failed to load convId=${convId}: ${(convErr as Error).message}`)
      }
    }

    // Resolve agent name from the desktop's agent state.
    // The agent state snapshot in the renderer maps compound keys to agent
    // arrays; we look up the first agent whose conversationId matches one
    // of the requested IDs so the iOS side can key the response.
    let agentName = ''
    if (state.mainWindow) {
      try {
        const convIdsJson = JSON.stringify(cmd.conversationIds)
        agentName = await state.mainWindow.webContents.executeJavaScript(`
          (function() {
            var store = window.__Ion_SESSION_STORE__;
            if (!store) return '';
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
                      if (d.conversationId === cid) return a.name;
                    }
                  }
                  // Belt-and-suspenders: fall back to legacy fields in case
                  // dispatches[] is empty (e.g. stale renderer state).
                  var aConvId = meta.conversationId || '';
                  var aConvIds = meta.conversationIds || [];
                  for (var cid of convIds) {
                    if (cid === aConvId || aConvIds.indexOf(cid) >= 0) return a.name;
                  }
                }
              }
            }
            return '';
          })()
        `) || ''
      } catch (_) {
        // Best-effort name resolution; empty string is fine
      }
    }

    log(`load_agent_conversation: resolved agentName=${agentName || '(unknown)'}, totalMessages=${allMessages.length}`)
    // Echo back the conversationId when loading a single dispatch so the
    // iOS client can cache per-dispatch conversations independently.
    const singleConvId = cmd.conversationIds.length === 1 ? cmd.conversationIds[0] : undefined
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_agent_conversation_history', agentName, conversationId: singleConvId, messages: allMessages })
  } catch (err) {
    log(`load_agent_conversation error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_agent_conversation_history', agentName: '', messages: [] })
  }
}
