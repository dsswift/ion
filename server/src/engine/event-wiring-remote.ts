import { readFileSync } from 'fs'
import type { NormalizedEvent } from '@ion/shared/types'
import { log as _log, warn as _warn } from '../logger'
import { sessionPlane, activeAssistantMessages, lastMessagePreview } from '../state'
import { normalizedToRemote } from '../remote/protocol'
import { useSessionStore } from '../store/sessionStore'
import { sendRemoteEvent, remoteClientsPresent } from '../thin-view/remote-out'
import { pushConversationTitle } from '../thin-view/push-title'

/**
 * A "needs you" push's title: the conversation's own title when this server
 * allows titles in pushes, so several at once read differently; otherwise
 * the generic line. The body says what the conversation needs.
 */
function attentionPushTitle(tabId: string): string {
  return pushConversationTitle(useSessionStore.getState().tabs.find((t) => t.id === tabId)) ?? 'Ion needs your attention'
}

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

/**
 * Find the plan file path of a tab's most recent plan-producing Write (or an
 * ExitPlanMode permission denial), reading the store directly (no window, no
 * executeJavaScript hop). Returns undefined when no plan path is found.
 *
 * Shared by both the permission-denial and task-complete forwarding paths so the
 * probe cannot drift between the two.
 */
function probePlanPathFromRenderer(tabId: string): string | undefined {
  const s = useSessionStore.getState()
  const tab = s.tabs.find((t) => t.id === tabId)
  if (!tab) return undefined
  const pane = s.conversationPanes.get(tab.id)
  const inst = pane ? (pane.instances.find((i) => i.id === pane.activeInstanceId) ?? pane.instances[0]) : null
  const msgs = inst?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { toolName?: string; toolInput?: string }
    if (m.toolName === 'Write' && m.toolInput) {
      try {
        const input = JSON.parse(m.toolInput) as { file_path?: string }
        const fp = input.file_path
        if (fp && /\/\.ion\/plans\/[^/]+\.md$/.test(fp)) return fp
      } catch { /* malformed tool input; try the next message */ }
    }
  }
  const denied = inst?.permissionDenied?.tools
  if (denied) {
    for (const d of denied) {
      if (d.toolName === 'ExitPlanMode' && (d.toolInput as { planFilePath?: string } | undefined)?.planFilePath) {
        return (d.toolInput as { planFilePath?: string }).planFilePath
      }
    }
  }
  return undefined
}

export function wireRemoteSessionPlaneForwarding(): void {
  sessionPlane.on('event', (tabId: string, event: NormalizedEvent) => {
    void (async () => {
    if (!remoteClientsPresent()) return

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
        const pushTitle = attentionPushTitle(tabId)
        const pushBody = event.toolName === 'AskUserQuestion'
          ? 'Question waiting for your answer'
          : event.toolName === 'ExitPlanMode'
            ? 'Plan ready for your review'
            : `Permission needed: ${event.toolName}`
        // tabId in the push metadata is what lets an APNs tap open the
        // right conversation (AppDelegate navigates by tabId).
        sendRemoteEvent(remoteEvent, true, { title: pushTitle, body: pushBody, tabId })
      } else {
        sendRemoteEvent(remoteEvent)
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
        if (exitPlanDenial && remoteClientsPresent()) {
          let planPath = exitPlanDenial.toolInput?.planFilePath as string | undefined

          if (!planPath) {
            planPath = probePlanPathFromRenderer(tabId)
          }

          let toolInput: Record<string, unknown> = { ...(exitPlanDenial.toolInput || {}) }
          if (planPath) {
            try {
              const content = readFileSync(planPath, 'utf-8')
              toolInput = { ...toolInput, planFilePath: planPath, planContent: content }
            } catch (err) {
              log('failed to read plan file for remote task_complete', { error: (err as Error).message })
            }
          }

          sendRemoteEvent({
            type: 'desktop_permission_request',
            tabId,
            questionId: `denied-${exitPlanDenial.toolUseId}`,
            toolName: 'ExitPlanMode',
            toolInput,
            options: [],
          }, true, { title: attentionPushTitle(tabId), body: 'Plan ready for your review', tabId })
        }

        // Forward AskUserQuestion denials the same way. The engine records
        // these as PermissionDenials in task_complete (same as ExitPlanMode)
        // but the task_complete handler previously ignored them, so iOS never
        // received a permission_request and the card never appeared.
        const askDenial = event.permissionDenials?.find(
          (d) => d.toolName === 'AskUserQuestion',
        )
        if (askDenial && remoteClientsPresent()) {
          log('task_complete: forwarding denial to remote', { question_id: 'denied-' + askDenial.toolUseId })
          sendRemoteEvent({
            type: 'desktop_permission_request',
            tabId,
            questionId: `denied-${askDenial.toolUseId}`,
            toolName: 'AskUserQuestion',
            toolInput: askDenial.toolInput,
            options: [],
          }, true, { title: attentionPushTitle(tabId), body: 'Question waiting for your answer', tabId })
        }
        break
      }
    }
    })().catch((err) => warn('remote: session-plane event forwarding failed', { tab_id: tabId, error: String(err) }))
  })

  sessionPlane.on('remote-permission', (tabId: string, data: {
    questionId: string; toolName: string;
    toolInput?: Record<string, unknown>;
    options: Array<{ id: string; label: string; kind?: string }>
  }) => {
    void (async () => {
    log('remote_permission_received', { tool: data.toolName, question_id: data.questionId, has_transport: remoteClientsPresent(), has_tool_input: !!data.toolInput })
    if (!remoteClientsPresent()) return
    let toolInput = data.toolInput
    if (data.toolName === 'ExitPlanMode') {
      let planPath = toolInput?.planFilePath as string | undefined

      if (!planPath) {
        planPath = probePlanPathFromRenderer(tabId)
      }

      if (planPath) {
        try {
          const content = readFileSync(planPath, 'utf-8')
          toolInput = { ...(toolInput || {}), planFilePath: planPath, planContent: content }
        } catch (err) {
          log('failed to read plan file for remote', { error: (err as Error).message })
        }
      }
    }
    const pushTitle = attentionPushTitle(tabId)
    const pushBody = data.toolName === 'AskUserQuestion'
      ? 'Question waiting for your answer'
      : data.toolName === 'ExitPlanMode'
        ? 'Plan ready for your review'
        : `Permission needed: ${data.toolName}`
    sendRemoteEvent({
      type: 'desktop_permission_request', tabId,
      questionId: data.questionId, toolName: data.toolName,
      toolInput, options: data.options,
      // tabId in the push metadata routes an APNs tap to the conversation.
    }, true, { title: pushTitle, body: pushBody, tabId })
    if (data.toolName !== 'AskUserQuestion' && data.toolName !== 'ExitPlanMode') {
      const resolveOnTerminalTransition = (changedTabId: string, status: string, previousStatus?: string) => {
        if (changedTabId !== tabId) return
        // A status resync has equal current/previous values. It restores an
        // optimistic client, not a run outcome, so it cannot resolve a live
        // permission request.
        if (previousStatus === status) return
        if (status === 'idle' || status === 'failed' || status === 'dead') {
          sessionPlane.off('tab-status-change', resolveOnTerminalTransition)
          sendRemoteEvent({
            type: 'desktop_permission_resolved', tabId,
            questionId: data.questionId,
          })
        }
      }
      sessionPlane.on('tab-status-change', resolveOnTerminalTransition)
    }
    })().catch((err) => warn('remote: remote-permission forwarding failed', { tab_id: tabId, error: String(err) }))
  })

  sessionPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus?: string) => {
    if (newStatus === 'idle' || newStatus === 'failed' || newStatus === 'dead') {
      activeAssistantMessages.delete(tabId)
    }
    if (!remoteClientsPresent()) return
    // Push "Task completed" only on a genuine run→idle transition. A
    // session-ready idle (the control plane forwarding idle for a freshly
    // started, never-run session — see handleStatusEvent's isReadyIdle branch)
    // arrives with oldStatus 'idle'/'connecting' and must NOT push a spurious
    // completion to iOS. A real completion transitions from 'running'.
    const pushOnIdle = newStatus === 'idle' && oldStatus === 'running'
    const pushMeta = pushOnIdle
      ? { title: 'Task completed', body: lastMessagePreview.get(tabId) || 'Tab is now idle' }
      : undefined
    const resync = oldStatus === newStatus
    sendRemoteEvent({
      type: 'desktop_tab_status', tabId, status: newStatus as any,
      ...(resync ? { resync: true } : {}),
    }, pushOnIdle, pushMeta)
  })

  // Push a desktop_tab_meta delta whenever the tab title changes. Tab titles
  // are set by the engine on first assistant message and whenever a new
  // conversation is started. Without this delta, iOS must wait up to 5 s for
  // the next snapshot poll to see the updated title.
  sessionPlane.on('tab-title-change', (tabId: string, newTitle: string) => {
    if (!remoteClientsPresent()) return
    log('tab_title_change', { tab_id: tabId, title: newTitle.slice(0, 40) })
    sendRemoteEvent({ type: 'desktop_tab_meta', tabId, title: newTitle })
  })
}
