import { readFileSync } from 'fs'
import { IPC } from '../shared/types'
import type { NormalizedEvent, EnrichedError } from '../shared/types'
import { log as _log } from './logger'
import { state, sessionPlane, engineBridge, activeAssistantMessages, activeToolInputs, lastMessagePreview, extensionCommandRegistry, forwardedEnginePermissionDenials, lastForwardedEngineTabStatus } from './state'
import { broadcast } from './broadcast'
import { currentBackend } from './settings-store'
import { normalizedToRemote } from './remote/protocol'
import { formatClearDivider } from '../shared/clear-divider'

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

    // engine_command_registry: refresh the main-process routing-hint cache
    // BEFORE broadcasting so the unified prompt pipeline always observes the
    // newest snapshot if a slash command is dispatched in the same tick.
    // Snapshot semantics — see state.ts comment on extensionCommandRegistry.
    if (event.type === 'engine_command_registry') {
      const listings = Array.isArray(event.commands) ? event.commands : []
      if (listings.length === 0) {
        // Empty list is the authoritative "no extension commands" signal —
        // drop the entry entirely so a future re-populate sees a clean slot
        // and routing-hint MISSes correctly trigger the engine-resolved
        // backstop. Leaving an empty Set in the map would be observationally
        // identical but harder to reason about in logs.
        const had = extensionCommandRegistry.has(key)
        extensionCommandRegistry.delete(key)
        log(`engine_command_registry: cleared key=${key} (was=${had})`)
      } else {
        const names = new Set<string>(listings.map((l: { name: string }) => l.name))
        extensionCommandRegistry.set(key, names)
        log(`engine_command_registry: cached key=${key} count=${names.size} names=[${[...names].join(',')}]`)
      }
    }

    broadcast(IPC.ENGINE_EVENT, key, event)

    // Trace agent_state so we can correlate engine→desktop→iOS flow when
    // diagnosing stuck-row, stale-snapshot, or missing-conversation reports.
    // Pairs with the engine's `agent_snapshot_emitted` utils.Log line.
    // Always log — not gated on remoteTransport — so desktop.log is
    // sufficient for diagnosis even without an iOS device connected.
    if (event.type === 'engine_agent_state') {
      const agents = Array.isArray(event.agents) ? event.agents : []
      const statuses = agents.map((a: any) => `${a.name}:${a.status}`).join(',')
      log(`engineBridge: agent_state key=${key} count=${agents.length} statuses=[${statuses}]`)
      // Log dispatch metadata for terminal agents so we can verify
      // conversationId survives the engine→desktop pipeline.
      for (const a of agents) {
        if ((a.status === 'done' || a.status === 'error') && a.metadata?.task) {
          const meta = a.metadata
          log(`engineBridge: dispatch_agent name=${a.name} status=${a.status} convId=${meta.conversationId ?? 'MISSING'} convIds=${JSON.stringify(meta.conversationIds ?? 'MISSING')} convIdsType=${typeof meta.conversationIds}`)
        }
      }
    }

    if (state.remoteTransport) {
      const tabId = key.split(':')[0]
      const instanceId = key.split(':')[1] || null
      // Every engine event the desktop sees gets forwarded to iOS, with
      // no per-event filtering. The previous special case that skipped
      // engine_early_stop_decision_request was removed once iOS gained
      // a decoder for it (see ios/IonRemote/Models/NormalizedEvent.swift
      // and the contract test in ContractSyncTests.swift). iOS observes
      // the event for diagnostic visibility only — the desktop is the
      // authoritative responder via early-stop-policy.ts — but the wire
      // protocol is now uniform across consumers.
      state.remoteTransport.send({ type: `engine_${event.type.replace('engine_', '')}`, tabId, instanceId, ...event })

      // Synthesize a `permission_request` envelope for iOS when an
      // engine-view `engine_status` event carries AskUserQuestion or
      // ExitPlanMode denials. The CLI/sessionPlane path forwards these
      // from `task_complete` in wireRemoteSessionPlaneForwarding above,
      // but engine-view events never reach sessionPlane (key mismatch:
      // EngineControlPlane is keyed by bare tabId, engine events arrive
      // with `tabId:instanceId`). Without this block, iOS receives the
      // engine_status itself (forwarded above) but has no decoder for
      // `permissionDenials` inside it — the card-rendering path on iOS
      // is keyed off `permission_request`. See plan-section "Files to
      // modify → event-wiring.ts" for the cross-reference.
      //
      // Dedupe via forwardedEnginePermissionDenials: engine_status fires
      // repeatedly, so without a guard every cost-only tick would re-push
      // the same envelope and re-fire the iOS push notification.
      if (event.type === 'engine_status' && Array.isArray(event.fields?.permissionDenials) && event.fields.permissionDenials.length > 0 && instanceId) {
        for (const denial of event.fields.permissionDenials) {
          if (denial.toolName !== 'AskUserQuestion' && denial.toolName !== 'ExitPlanMode') continue
          const questionId = `denied-${denial.toolUseId}`
          if (forwardedEnginePermissionDenials.has(questionId)) {
            // Already pushed for this toolUseId — skip silently. We hit
            // this path on every cost-only engine_status tick after the
            // initial denial-carrying tick.
            continue
          }
          forwardedEnginePermissionDenials.add(questionId)
          const pushBody = denial.toolName === 'AskUserQuestion'
            ? 'Question waiting for your answer'
            : 'Plan ready for your review'
          log(`engine_status: forwarding ${denial.toolName} denial to remote key=${key} questionId=${questionId}`)
          state.remoteTransport.send({
            type: 'permission_request',
            tabId,
            questionId,
            toolName: denial.toolName,
            toolInput: denial.toolInput,
            options: [],
          }, true, { title: 'Ion needs your attention', body: pushBody })
        }
      }

      // Synthesize a `tab_status` event for iOS when an engine-view
      // `engine_status` reports a state transition. Engine-view events
      // bypass EngineControlPlane (compound-key mismatch), so no
      // `tab-status-change` fires on the sessionPlane — iOS never learns
      // the tab moved from 'running' to 'idle'/'completed'. The desktop
      // renderer handles this locally in engine-event-slice.ts, but iOS
      // depends on explicit `tab_status` messages.
      //
      // Mirrors engine-control-plane-events.ts:handleStatusEvent logic:
      //   - idle + AskUserQuestion/ExitPlanMode denials → 'completed'
      //   - idle (no denials) → 'idle'
      //   - running → 'running'
      //
      // Deduped via lastForwardedEngineTabStatus to avoid flooding on
      // cost-only ticks (engine_status fires repeatedly with the same
      // state while the run is in progress or idling).
      if (event.type === 'engine_status' && event.fields?.state && instanceId) {
        const fieldState = event.fields.state as string
        let derivedStatus: string | null = null
        if (fieldState === 'idle') {
          const hasInteresting = Array.isArray(event.fields.permissionDenials) &&
            event.fields.permissionDenials.some(
              (d: { toolName: string }) => d.toolName === 'ExitPlanMode' || d.toolName === 'AskUserQuestion',
            )
          derivedStatus = hasInteresting ? 'completed' : 'idle'
        } else if (fieldState === 'running') {
          derivedStatus = 'running'
        }
        if (derivedStatus && lastForwardedEngineTabStatus.get(tabId) !== derivedStatus) {
          lastForwardedEngineTabStatus.set(tabId, derivedStatus)
          log(`engine_status: synthesizing tab_status for remote tabId=${tabId} instance=${instanceId} derivedStatus=${derivedStatus}`)
          state.remoteTransport.send({ type: 'tab_status', tabId, status: derivedStatus as any })
        }
      }

      // /clear success → relay an iOS-renderable divider so the mobile
      // client sees the checkpoint immediately. We piggy-back on the
      // existing envelopes iOS already decodes: `engine_harness_message`
      // for engine tabs (NormalizedEvent.engineHarnessMessage handler),
      // `message_added` for CLI tabs. Without this relay iOS would have
      // to learn a new event type to render the divider; using the
      // existing ones means iOS works without any Swift change.
      //
      // The renderer (engine-event-slice.ts) draws its own divider from
      // the same engine_command_result event, so desktop and iOS both
      // light up from a single engine signal.
      if (event.type === 'engine_command_result' && event.command === 'clear' && !event.commandError) {
        // The engine successfully cleared the conversation. Advance the
        // desktop's freshness checkpoint so the next slash command on this
        // tab is treated as the first prompt of a blank conversation by
        // `isFirstPromptForTab` in slash-classify.ts. The engine
        // intentionally keeps `s.conversationID` set (/clear is a
        // checkpoint, not a session restart) — without this notification
        // the post-/clear slash would see `promptCountSinceCheckpoint > 0`
        // and incorrectly preserve plan mode.
        log(`engine_command_result clear: notifying conversationCleared tabId=${tabId}`)
        sessionPlane.notifyConversationCleared(tabId)

        const divider = formatClearDivider(new Date())
        if (instanceId) {
          state.remoteTransport.send({
            type: 'engine_harness_message',
            tabId,
            instanceId,
            message: divider,
            source: 'clear',
          })
        } else {
          state.remoteTransport.send({
            type: 'message_added',
            tabId,
            message: {
              id: `clear-${Date.now()}`,
              role: 'system',
              content: divider,
              timestamp: Date.now(),
              source: 'desktop',
            },
          })
        }
      }
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
            type: 'permission_request',
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

