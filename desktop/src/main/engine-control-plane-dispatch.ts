// Dispatch/agent-state event handlers extracted from
// engine-control-plane-events.ts (split by event domain to keep every file
// under the 600-line cap). These are the `engine_agent_state`,
// `engine_dispatch_start`, and `engine_dispatch_end` arms of the
// EngineEvent→NormalizedEvent translation switch, lifted out verbatim. No logic
// change. The main file delegates to handleDispatchEvent from its switch.
import type { EngineEvent, NormalizedEvent } from '../shared/types'
import type { EventEmitterContext, TabEntry } from './engine-control-plane-events-types'

/**
 * Handle the dispatch/agent-state event arms. Returns true when the event type
 * was one of these arms, false otherwise. Behavior is identical to the former
 * inline cases.
 */
export function handleDispatchEvent(
  ctx: EventEmitterContext,
  tabId: string,
  _tab: TabEntry,
  event: EngineEvent,
): boolean {
  switch (event.type) {
    case 'engine_agent_state':
      // Emit as normalized agent_state so the single reducer can update
      // the active instance's agentStates in event-slice.ts. Previously
      // only engine-event-slice.ts handled this via the raw stream.
      ctx.emit('event', tabId, {
        type: 'agent_state',
        agents: event.agents || [],
      } as NormalizedEvent)
      return true

    case 'engine_dispatch_start':
      // Forward dispatch start telemetry to the renderer so the store can
      // record depth/parentDispatchId for nested dispatch tree rendering.
      // dispatchId is required so buildDispatchStartEntry produces a
      // DispatchTelemetryEntry with a real id — without it the snapshot ships
      // '' to iOS and tier-3 child join (dispatchParentId == dispatchId) collapses.
      ctx.emit('event', tabId, {
        type: 'dispatch_start',
        dispatchId: event.dispatchId || '',
        dispatchAgent: event.dispatchAgent || '',
        dispatchTask: event.dispatchTask || '',
        dispatchModel: event.dispatchModel || '',
        dispatchSessionId: event.dispatchSessionId || '',
        dispatchDepth: event.dispatchDepth || 0,
        dispatchParentId: event.dispatchParentId || '',
      } as NormalizedEvent)
      return true

    case 'engine_dispatch_end':
      // dispatchId matches the corresponding dispatch_start so applyDispatchEnd
      // can update the correct DispatchTelemetryEntry (exact id match, not
      // heuristic). dispatchConversationId is read by the slice helper to set
      // the entry's conversationId and is forwarded to iOS via the snapshot.
      ctx.emit('event', tabId, {
        type: 'dispatch_end',
        dispatchId: event.dispatchId || '',
        dispatchAgent: event.dispatchAgent || '',
        dispatchExitCode: event.dispatchExitCode ?? 0,
        dispatchElapsed: event.dispatchElapsed ?? 0,
        dispatchCost: event.dispatchCost ?? 0,
        dispatchInputTokens: event.dispatchInputTokens ?? 0,
        dispatchOutputTokens: event.dispatchOutputTokens ?? 0,
        dispatchToolCount: event.dispatchToolCount ?? 0,
        dispatchDepth: event.dispatchDepth || 0,
        dispatchParentId: event.dispatchParentId || '',
        dispatchConversationId: event.dispatchConversationId || '',
      } as NormalizedEvent)
      return true
  }
  return false
}
