import { readFileSync } from 'fs'
import { IPC } from '../shared/types'
import type { NormalizedEvent, EnrichedError } from '../shared/types'
import { log as _log } from './logger'
import { state, sessionPlane, engineBridge, activeAssistantMessages, activeToolInputs, lastMessagePreview } from './state'
import { broadcast } from './broadcast'
import { currentBackend } from './settings-store'
import { normalizedToRemote } from './remote/protocol'

function log(msg: string): void {
  _log('main', msg)
}

export function wireSessionPlaneEvents(): void {
  sessionPlane.on('event', (tabId: string, event: NormalizedEvent) => {
    broadcast('ion:normalized-event', tabId, event)
  })

  sessionPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
    broadcast('ion:tab-status-change', tabId, newStatus, oldStatus)
  })

  sessionPlane.on('error', (tabId: string, error: EnrichedError) => {
    broadcast('ion:enriched-error', tabId, error)
  })
}

export function wireEngineBridgeEvents(): void {
  engineBridge.on('event', (key: string, event: any) => {
    if (event.type === 'engine_status' && event.fields) {
      event = { ...event, fields: { ...event.fields, backend: currentBackend } }
    }
    broadcast(IPC.ENGINE_EVENT, key, event)
    if (state.remoteTransport) {
      const tabId = key.split(':')[0]
      const instanceId = key.split(':')[1] || null
      state.remoteTransport.send({ type: `engine_${event.type.replace('engine_', '')}`, tabId, instanceId, ...event })
    }
    // Auto-reconcile on event drops so state self-heals
    if (event.type === 'engine_events_dropped') {
      engineBridge.sendReconcileState(key)
    }
  })
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

    switch (event.type) {
      case 'text_chunk': {
        let msg = activeAssistantMessages.get(tabId)
        if (!msg) {
          msg = { id: `assistant-${Date.now()}-${tabId}`, content: event.text }
          activeAssistantMessages.set(tabId, msg)
          state.remoteTransport.send({
            type: 'message_added',
            tabId,
            message: {
              id: msg.id,
              role: 'assistant',
              content: event.text,
              timestamp: Date.now(),
            },
          })
        } else {
          msg.content += event.text
          state.remoteTransport.send({
            type: 'message_updated',
            tabId,
            messageId: msg.id,
            content: msg.content,
          })
        }
        break
      }
      case 'tool_call': {
        activeAssistantMessages.delete(tabId)
        state.remoteTransport.send({
          type: 'message_added',
          tabId,
          message: {
            id: event.toolId,
            role: 'tool',
            content: '',
            toolName: event.toolName,
            toolId: event.toolId,
            toolStatus: 'running',
            timestamp: Date.now(),
          },
        })
        break
      }
      case 'tool_call_update': {
        if (!activeToolInputs.has(tabId)) activeToolInputs.set(tabId, new Map())
        const tabTools = activeToolInputs.get(tabId)!
        const current = (tabTools.get(event.toolId) || '') + event.partialInput
        tabTools.set(event.toolId, current)
        state.remoteTransport.send({
          type: 'message_updated',
          tabId,
          messageId: event.toolId,
          toolInput: current,
        })
        break
      }
      case 'tool_result': {
        const content = event.content.length > 2048
          ? event.content.substring(0, 2048) + '\n... [truncated]'
          : event.content
        state.remoteTransport.send({
          type: 'message_updated',
          tabId,
          messageId: event.toolId,
          content,
          toolStatus: event.isError ? 'error' : 'completed',
        })
        break
      }
      case 'task_complete': {
        const assistantMsg = activeAssistantMessages.get(tabId)
        if (assistantMsg?.content) {
          lastMessagePreview.set(tabId, assistantMsg.content.substring(0, 100))
        }
        activeAssistantMessages.delete(tabId)
        activeToolInputs.delete(tabId)

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
                  var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTabId}'; });
                  if (!tab) return null;
                  var msgs = tab.messages || [];
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
                  var denied = tab.permissionDenied && tab.permissionDenied.tools;
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
            type: 'permission_request',
            tabId,
            questionId: `denied-${exitPlanDenial.toolUseId}`,
            toolName: 'ExitPlanMode',
            toolInput,
            options: [],
          }, true, { title: 'Ion needs your attention', body: 'Plan ready for your review' })
        }
        break
      }
      case 'compacting': {
        // When compaction finishes, send a system message to iOS so it renders
        // the compaction marker in the conversation (mirrors desktop event-slice).
        if (!event.active && (event.messagesBefore || event.summary)) {
          const parts = ['[Compaction]']
          if (event.strategy) parts.push(event.strategy)
          if (event.messagesBefore && event.messagesAfter != null) {
            parts.push(`${event.messagesBefore} → ${event.messagesAfter} messages`)
          }
          if (event.clearedBlocks) parts.push(`${event.clearedBlocks} blocks cleared`)
          let content = parts.join(' · ')
          if (event.summary) content += '\n\n' + event.summary
          state.remoteTransport.send({
            type: 'message_added',
            tabId,
            message: {
              id: `compaction-${Date.now()}-${tabId}`,
              role: 'system',
              content,
              timestamp: Date.now(),
            },
          })
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
              var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTabId}'; });
              if (!tab) return null;
              var msgs = tab.messages || [];
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
              var denied = tab.permissionDenied && tab.permissionDenied.tools;
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
      type: 'permission_request', tabId,
      questionId: data.questionId, toolName: data.toolName,
      toolInput, options: data.options,
    }, true, { title: pushTitle, body: pushBody })
    if (data.toolName !== 'AskUserQuestion' && data.toolName !== 'ExitPlanMode') {
      const resolveOnIdle = (changedTabId: string, status: string) => {
        if (changedTabId !== tabId) return
        if (status === 'idle' || status === 'failed' || status === 'dead') {
          sessionPlane.off('tab-status-change', resolveOnIdle)
          state.remoteTransport?.send({
            type: 'permission_resolved', tabId,
            questionId: data.questionId,
          })
        }
      }
      sessionPlane.on('tab-status-change', resolveOnIdle)
    }
  })

  sessionPlane.on('tab-status-change', (tabId: string, newStatus: string) => {
    if (newStatus === 'idle' || newStatus === 'failed' || newStatus === 'dead') {
      activeAssistantMessages.delete(tabId)
    }
    if (!state.remoteTransport) return
    const pushOnIdle = newStatus === 'idle'
    const pushMeta = pushOnIdle
      ? { title: 'Task completed', body: lastMessagePreview.get(tabId) || 'Tab is now idle' }
      : undefined
    state.remoteTransport.send({ type: 'tab_status', tabId, status: newStatus as any }, pushOnIdle, pushMeta)
  })
}

