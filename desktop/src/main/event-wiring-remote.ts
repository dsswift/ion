import { readFileSync } from 'fs'
import type { NormalizedEvent } from '../shared/types'
import { log as _log } from './logger'
import { state, sessionPlane, activeAssistantMessages, lastMessagePreview } from './state'
import { normalizedToRemote } from './remote/protocol'
import { formatClearDivider } from '../shared/clear-divider'
import { buildCompactionMarkerContent } from '../shared/compaction-marker'

function log(msg: string): void {
  _log('main', msg)
}

export function wireRemoteSessionPlaneForwarding(): void {
  sessionPlane.on('event', async (tabId: string, event: NormalizedEvent) => {
    if (!state.remoteTransport) return

    if (
      event.type === 'permission_request' &&
      (event.toolName === 'AskUserQuestion' || event.toolName === 'ExitPlanMode')
    ) {
      return
    }

    const remoteEvent = normalizedToRemote(tabId, event)
    if (remoteEvent) {
      const needsPush = event.type === 'permission_request'
      // Suppress the legacy normalizedToRemote wire-send for event types that
      // are now fully covered by the engine-bridge critical-event path:
      //   text_chunk     → desktop_text_delta   (wireEngineBridgeEvents batch flush)
      //   tool_call      → desktop_tool_start   (wireEngineBridgeEvents generic forwarder)
      //   tool_call_update → desktop_tool_update (wireEngineBridgeEvents generic forwarder)
      //   tool_result    → desktop_tool_end     (wireEngineBridgeEvents generic forwarder)
      //
      // Sending both produced non-critical duplicates (desktop_text_chunk,
      // desktop_tool_call, desktop_tool_result) at per-event rate (50-200/sec),
      // flooding the transport queue. iOS already ignores them for loaded
      // conversations (conversationLoaded guard), but the volume degrades
      // throughput on the relay path.
      //
      // task_complete, compacting, error, and permission_request are session-
      // plane-only events with NO engine-bridge equivalent; they must continue
      // to be forwarded here.
      const isCoveredByEngineBridge = (
        event.type === 'text_chunk' ||
        event.type === 'tool_call' ||
        event.type === 'tool_call_update' ||
        event.type === 'tool_result'
      )
      if (!isCoveredByEngineBridge) {
        if (needsPush) {
          const pushTitle = 'Ion needs your attention'
          const pushBody = event.toolName === 'AskUserQuestion'
            ? 'Question waiting for your answer'
            : event.toolName === 'ExitPlanMode'
              ? 'Plan ready for your review'
              : `Permission needed: ${event.toolName}`
          state.remoteTransport.send(remoteEvent, true, { title: pushTitle, body: pushBody })
        } else {
          state.remoteTransport.send(remoteEvent)
        }
      }
    }

    switch (event.type) {
      case 'text_chunk': {
        // Track the assistant message content for lastMessagePreview (read in
        // task_complete below). We do NOT mirror this as a desktop_message_added
        // / desktop_message_updated envelope to iOS: the generic engine
        // forwarder in event-wiring.ts (wireEngineBridgeEvents) already forwards
        // the structured engine_text_delta as desktop_text_delta for EVERY
        // engine-backed conversation, and iOS appends/extends the assistant row
        // from that. Post-#256 every conversation is engine-backed with a bare
        // session key, so the control plane matches and BOTH this path and the
        // generic forwarder fire — emitting the message envelope here too
        // produced a second assistant row on iOS (the live-only duplication that
        // healed on history reload). The bookkeeping below stays; only the
        // duplicate wire send is removed.
        let msg = activeAssistantMessages.get(tabId)
        if (!msg) {
          msg = { id: `assistant-${Date.now()}-${tabId}`, content: event.text }
          activeAssistantMessages.set(tabId, msg)
        } else {
          msg.content += event.text
        }
        break
      }
      case 'tool_call': {
        // No desktop_message_added(tool) here — the generic forwarder emits
        // desktop_tool_start for the same engine_tool_start, and iOS appends the
        // tool row from that (keyed by toolId). Emitting the envelope here too
        // appended a second tool row with the same toolId. Keep the
        // activeAssistantMessages reset (a tool call ends the current assistant
        // text run) but drop the duplicate wire send.
        activeAssistantMessages.delete(tabId)
        break
      }
      // tool_call_update and tool_result are fully covered by the engine-bridge
      // critical-event path (wireEngineBridgeEvents emits desktop_tool_update /
      // desktop_tool_end for the same events). No session-plane action needed here.
      default:
        break
      case 'task_complete': {
        const assistantMsg = activeAssistantMessages.get(tabId)
        if (assistantMsg?.content) {
          lastMessagePreview.set(tabId, assistantMsg.content.substring(0, 100))
        }
        activeAssistantMessages.delete(tabId)

        const exitPlanDenial = event.permissionDenials?.find(
          (d) => d.toolName === 'ExitPlanMode',
        )
        if (exitPlanDenial && state.remoteTransport) {
          let planPath = exitPlanDenial.toolInput?.planFilePath as string | undefined

          if (!planPath && state.mainWindow) {
            try {
              const escapedTabId = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
              planPath = await state.mainWindow.webContents.executeJavaScript(`
                (function() {
                  var store = window.__Ion_SESSION_STORE__;
                  if (!store) return null;
                  var s = store.getState();
                  var tab = s.tabs.find(function(t) { return t.id === '${escapedTabId}'; });
                  if (!tab) return null;
                  // Per-conversation state now lives on the active ConversationInstance.
                  var pane = s.conversationPanes ? s.conversationPanes.get(tab.id) : null;
                  var inst = pane ? (pane.instances.find(function(i){ return i.id === pane.activeInstanceId; }) || pane.instances[0]) : null;
                  var msgs = (inst && inst.messages) || [];
                  for (var i = msgs.length - 1; i >= 0; i--) {
                    var m = msgs[i];
                    if (m.toolName === 'Write' && m.toolInput) {
                      try {
                        var input = JSON.parse(m.toolInput);
                        var fp = input.file_path;
                        if (fp && /\\/\\.ion\\/plans\\/[^/]+\\.md$/.test(fp)) return fp;
                      } catch(e) {}
                    }
                  }
                  // Fallback: check permissionDenied for planFilePath
                  var denied = inst && inst.permissionDenied && inst.permissionDenied.tools;
                  if (denied) {
                    for (var d = 0; d < denied.length; d++) {
                      if (denied[d].toolName === 'ExitPlanMode' && denied[d].toolInput && denied[d].toolInput.planFilePath) {
                        return denied[d].toolInput.planFilePath;
                      }
                    }
                  }
                  return null;
                })()
              `) || undefined
            } catch {}
          }

          let toolInput: Record<string, unknown> = { ...(exitPlanDenial.toolInput || {}) }
          if (planPath) {
            try {
              const content = readFileSync(planPath, 'utf-8')
              toolInput = { ...toolInput, planFilePath: planPath, planContent: content }
            } catch (err) {
              log(`Failed to read plan file for remote (task_complete): ${(err as Error).message}`)
            }
          }

          state.remoteTransport.send({
            type: 'desktop_permission_request',
            tabId,
            questionId: `denied-${exitPlanDenial.toolUseId}`,
            toolName: 'ExitPlanMode',
            toolInput,
            options: [],
          }, true, { title: 'Ion needs your attention', body: 'Plan ready for your review' })
        }

        // Forward AskUserQuestion denials the same way. The engine records
        // these as PermissionDenials in task_complete (same as ExitPlanMode)
        // but the task_complete handler previously ignored them, so iOS never
        // received a permission_request and the card never appeared.
        const askDenial = event.permissionDenials?.find(
          (d) => d.toolName === 'AskUserQuestion',
        )
        if (askDenial && state.remoteTransport) {
          log(`task_complete: forwarding AskUserQuestion denial to remote questionId=denied-${askDenial.toolUseId}`)
          state.remoteTransport.send({
            type: 'desktop_permission_request',
            tabId,
            questionId: `denied-${askDenial.toolUseId}`,
            toolName: 'AskUserQuestion',
            toolInput: askDenial.toolInput,
            options: [],
          }, true, { title: 'Ion needs your attention', body: 'Question waiting for your answer' })
        }
        break
      }
      case 'compacting': {
        // When compaction finishes, send a system message to iOS so it renders
        // the compaction marker in the conversation. Uses the shared builder so
        // the iOS-bound string is byte-identical to the desktop renderer's
        // (event-slice.ts) — including omitting "N → N" on a micro-only pass
        // and suppressing the marker entirely on a pure no-op.
        if (!event.active) {
          const content = buildCompactionMarkerContent(event)
          if (content !== null) {
            state.remoteTransport.send({
              type: 'desktop_message_added',
              tabId,
              message: {
                id: `compaction-${Date.now()}-${tabId}`,
                role: 'system',
                content,
                timestamp: Date.now(),
              },
            })
          }
        }
        break
      }
    }
  })

  sessionPlane.on('remote-permission', async (tabId: string, data: {
    questionId: string; toolName: string;
    toolInput?: Record<string, unknown>;
    options: Array<{ id: string; label: string; kind?: string }>
  }) => {
    log(`remote-permission received: tool=${data.toolName}, questionId=${data.questionId}, hasTransport=${!!state.remoteTransport}, hasToolInput=${!!data.toolInput}`)
    if (!state.remoteTransport) return
    let toolInput = data.toolInput
    if (data.toolName === 'ExitPlanMode') {
      let planPath = toolInput?.planFilePath as string | undefined

      if (!planPath && state.mainWindow) {
        try {
          const escapedTabId = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
          planPath = await state.mainWindow.webContents.executeJavaScript(`
            (function() {
              var store = window.__Ion_SESSION_STORE__;
              if (!store) return null;
              var s = store.getState();
              var tab = s.tabs.find(function(t) { return t.id === '${escapedTabId}'; });
              if (!tab) return null;
              // Per-conversation state now lives on the active ConversationInstance.
              var pane = s.conversationPanes ? s.conversationPanes.get(tab.id) : null;
              var inst = pane ? (pane.instances.find(function(i){ return i.id === pane.activeInstanceId; }) || pane.instances[0]) : null;
              var msgs = (inst && inst.messages) || [];
              for (var i = msgs.length - 1; i >= 0; i--) {
                var m = msgs[i];
                if (m.toolName === 'Write' && m.toolInput) {
                  try {
                    var input = JSON.parse(m.toolInput);
                    var fp = input.file_path;
                    if (fp && /\\/\\.ion\\/plans\\/[^/]+\\.md$/.test(fp)) return fp;
                  } catch(e) {}
                }
              }
              // Fallback: check permissionDenied for planFilePath
              var denied = inst && inst.permissionDenied && inst.permissionDenied.tools;
              if (denied) {
                for (var d = 0; d < denied.length; d++) {
                  if (denied[d].toolName === 'ExitPlanMode' && denied[d].toolInput && denied[d].toolInput.planFilePath) {
                    return denied[d].toolInput.planFilePath;
                  }
                }
              }
              return null;
            })()
          `) || undefined
        } catch {}
      }

      if (planPath) {
        try {
          const content = readFileSync(planPath, 'utf-8')
          toolInput = { ...(toolInput || {}), planFilePath: planPath, planContent: content }
        } catch (err) {
          log(`Failed to read plan file for remote: ${(err as Error).message}`)
        }
      }
    }
    const pushTitle = 'Ion needs your attention'
    const pushBody = data.toolName === 'AskUserQuestion'
      ? 'Question waiting for your answer'
      : data.toolName === 'ExitPlanMode'
        ? 'Plan ready for your review'
        : `Permission needed: ${data.toolName}`
    state.remoteTransport.send({
      type: 'desktop_permission_request', tabId,
      questionId: data.questionId, toolName: data.toolName,
      toolInput, options: data.options,
    }, true, { title: pushTitle, body: pushBody })
    if (data.toolName !== 'AskUserQuestion' && data.toolName !== 'ExitPlanMode') {
      const resolveOnIdle = (changedTabId: string, status: string) => {
        if (changedTabId !== tabId) return
        if (status === 'idle' || status === 'failed' || status === 'dead') {
          sessionPlane.off('tab-status-change', resolveOnIdle)
          state.remoteTransport?.send({
            type: 'desktop_permission_resolved', tabId,
            questionId: data.questionId,
          })
        }
      }
      sessionPlane.on('tab-status-change', resolveOnIdle)
    }
  })

  sessionPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus?: string) => {
    if (newStatus === 'idle' || newStatus === 'failed' || newStatus === 'dead') {
      activeAssistantMessages.delete(tabId)
    }
    if (!state.remoteTransport) return
    // Push "Task completed" only on a genuine run→idle transition. A
    // session-ready idle (the control plane forwarding idle for a freshly
    // started, never-run session — see handleStatusEvent's isReadyIdle branch)
    // arrives with oldStatus 'idle'/'connecting' and must NOT push a spurious
    // completion to iOS. A real completion transitions from 'running'.
    const pushOnIdle = newStatus === 'idle' && oldStatus === 'running'
    const pushMeta = pushOnIdle
      ? { title: 'Task completed', body: lastMessagePreview.get(tabId) || 'Tab is now idle' }
      : undefined
    state.remoteTransport.send({ type: 'desktop_tab_status', tabId, status: newStatus as any }, pushOnIdle, pushMeta)
  })
}
