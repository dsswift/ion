/**
 * engine-event-slice-messages — cross-cutting NormalizedEvent handlers
 *
 * Extracted from engine-event-slice.ts to keep that file under the
 * 600-line TypeScript cap.
 *
 * All engine events flow through the normalized stream (ion:normalized-event →
 * handleNormalizedEvent in event-slice.ts). This handling is TAB-TYPE-AGNOSTIC:
 * the per-tab reducer in event-slice.ts runs for any tabId with no tab-type
 * guard, so plain conversations (which can dispatch background sub-agents)
 * receive engine_* events exactly like extension-hosted ones. There is no
 * extension-tab-only event path. (A dead per-event handler previously lived
 * here documenting a tab-type gate that no longer exists in the live path; it
 * was removed to stop it re-asserting a false "extension tabs only" invariant.)
 *
 * Cross-cutting events handled here (fired for any tabId):
 *   command_registry, command_result
 *   resource_snapshot, resource_delta  ← global AND session scoped
 *   engine_notification
 */

import type { StoreSet, StoreGet } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { formatClearDivider } from '../../../shared/clear-divider'
import { applyResourceSnapshot, applyResourceDelta } from './resource-slice'
import type { ResourceItem } from '../../../shared/types-engine'
import { extensionCommandsByKey, dispatchActivityFoldByDispatchId } from './engine-event-slice-helpers'
import { commitInstance } from '../conversation-instance'
import { foldActivity, activityMessages, emptyActivityState } from '../../components/agent-dispatch-activity'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'

/**
 * handleCrossNormalizedEvent — cross-cutting NormalizedEvent handler (WI-001)
 *
 * After the single-path collapse, cross-cutting events (resource snapshots/
 * deltas, command lifecycle, notifications) flow through the normalized stream
 * (ion:normalized-event) as NormalizedEvent variants instead of IPC.ENGINE_EVENT.
 *
 * This function is called from handleNormalizedEvent in event-slice.ts when the
 * event type is one of the cross-cutting variants. It mirrors the logic of
 * handleCrossEngineEvent but operates on NormalizedEvent types ('command_registry',
 * 'command_result', 'resource_snapshot', 'resource_delta', 'engine_notification').
 *
 * Returns true when the event was consumed (caller should skip per-tab logic),
 * false when the event is not a cross-cutting type.
 */
export function handleCrossNormalizedEvent(
  set: StoreSet,
  _get: StoreGet,
  tabId: string,
  event: import('../../../shared/types-events').NormalizedEvent,
): boolean {
  if (event.type === 'command_registry') {
    const listings = Array.isArray(event.commands) ? event.commands : []
    if (listings.length === 0) {
      extensionCommandsByKey.delete(tabId)
    } else {
      extensionCommandsByKey.set(tabId, listings.map((l: { name: string; description?: string }) => ({ name: l.name, description: l.description })))
    }
    // No store mutation — autocomplete reads via getRendererExtensionCommands()
    // during keystroke handling; no reactive subscription needed.
    return true
  }
  if (event.type === 'command_result') {
    const cmdName = event.command || ''
    const failed = !!event.commandError
    if (cmdName === 'clear' && !failed) {
      const divider = formatClearDivider(new Date())
      // WI-001: all conversations use bare tabId + active instance (single-path).
      // Insert the clear divider and clear any pending permissionDenied card.
      set((state) => {
        const conversationPanes = commitInstance(state.conversationPanes, tabId, (inst) => ({
          ...inst,
          messages: [...inst.messages, { id: nextMsgId(), role: 'system' as const, content: divider, timestamp: Date.now() }],
          permissionDenied: null,
        }))
        return { conversationPanes }
      })
    }
    return true
  }
  if (event.type === 'resource_snapshot') {
    const items: ResourceItem[] = event.resourceItems ?? []
    set((state) =>
      applyResourceSnapshot(
        { resources: state.resources, resourceSubscriptions: state.resourceSubscriptions, readResourceIds: state.readResourceIds },
        event.resourceKind,
        event.resourceSubId ?? '',
        items,
      ),
    )
    return true
  }
  if (event.type === 'resource_delta') {
    if (event.resourceDelta) {
      set((state) =>
        applyResourceDelta(
          { resources: state.resources, resourceSubscriptions: state.resourceSubscriptions, readResourceIds: state.readResourceIds },
          event.resourceKind,
          event.resourceDelta,
        ),
      )
    }
    return true
  }
  if (event.type === 'engine_notification') {
    // Notification from extension ctx.notify(). Log-only — no store mutation.
    rInfo('event.notification', 'engine notification', { title: event.notificationTitle, level: event.notificationLevel })
    return true
  }
  if (event.type === 'dispatch_activity') {
    // Live dispatched-agent transcript delta. Fold it into the per-dispatch
    // push state (deduped by toolId / seq) and mirror the materialized
    // Message[] into the store so the agent popup re-renders. This is a
    // cross-cutting event — it NEVER touches the main conversation messages.
    //
    // Keyed by dispatchAgentId, NOT conversationId: a re-dispatched agent
    // reuses the same child conversationId but the engine issues a new
    // dispatchAgentId and resets seq to 0 for each dispatch. Keying by convId
    // would cause the two dispatches' push buffers to collide.
    const dispatchId = event.dispatchAgentId
    const convId = event.dispatchConversationId
    if (!dispatchId) {
      rWarn('event.dispatch', 'missing dispatchAgentId, dropping', { conversation_id: convId ?? '', seq: event.dispatchSeq })
      return true
    }
    const prev = dispatchActivityFoldByDispatchId.get(dispatchId) ?? emptyActivityState()
    const { state: next, branch } = foldActivity(prev, {
      dispatchConversationId: convId,
      dispatchActivityKind: event.dispatchActivityKind,
      dispatchSeq: event.dispatchSeq,
      toolName: event.toolName,
      toolId: event.toolId,
      dispatchTextDelta: event.dispatchTextDelta,
      dispatchToolIsError: event.dispatchToolIsError,
      dispatchActivityTs: event.dispatchActivityTs,
    })
    dispatchActivityFoldByDispatchId.set(dispatchId, next)
    // Log both dispatchId and convId so a push/reconcile divergence is
    // diagnosable from desktop.log without ambiguity.
    rDebug('event.dispatch', 'dispatch activity fold', { dispatch_id: dispatchId, conversation_id: convId ?? '', kind: event.dispatchActivityKind, seq: event.dispatchSeq, tool: event.toolId ?? '', branch })
    const messages = activityMessages(next)
    set((state) => ({
      dispatchActivity: { ...state.dispatchActivity, [dispatchId]: messages },
    }))
    return true
  }
  return false
}
