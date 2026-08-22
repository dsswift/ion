// Mid-run stream-signal event handlers extracted from
// engine-control-plane-events.ts (split by event domain to keep every file
// under the 600-line cap). These are the `engine_stream_reset`,
// `engine_compacting`, `engine_tool_stalled`, `engine_run_stalled`, and
// `engine_steer_injected` / `engine_steer_degraded` arms of the EngineEvent→NormalizedEvent translation
// switch, lifted out verbatim. No logic change. The main file delegates to
// handleStreamSignalEvent from its switch.
import type { EngineEvent, NormalizedEvent } from '../shared/types'
import { log as _log, debug as _debug } from './logger'
import type { EventEmitterContext, TabEntry } from './engine-control-plane-events-types'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }

/**
 * Handle the mid-run stream-signal event arms. Returns true when the event
 * type was one of these arms, false otherwise. Behavior is identical to the
 * former inline cases.
 */
export function handleStreamSignalEvent(
  ctx: EventEmitterContext,
  tabId: string,
  _tab: TabEntry,
  event: EngineEvent,
): boolean {
  switch (event.type) {
    case 'engine_stream_reset':
      log('stream_reset: retry in progress', { tab_id: tabId })
      ctx.emit('event', tabId, { type: 'stream_reset' } as NormalizedEvent)
      return true

    case 'engine_compacting':
      log('compacting', { tab_id: tabId, active: event.active, micro_only: event.microOnly ?? false, msgs_before: event.messagesBefore ?? 0, msgs_after: event.messagesAfter ?? 0 })
      // Forward the full detail field set, not just `active`. The renderer
      // marker (event-slice.ts) and the iOS-bound marker (event-wiring-remote.ts)
      // both read messagesBefore/messagesAfter/clearedBlocks/summary/strategy/
      // microOnly to build the "[Compaction]" checkpoint line. Dropping them
      // here (the prior behavior) left both markers as dead code — the fields
      // never arrived, so the marker was never inserted.
      ctx.emit('event', tabId, {
        type: 'compacting',
        active: event.active,
        summary: event.summary,
        messagesBefore: event.messagesBefore,
        messagesAfter: event.messagesAfter,
        clearedBlocks: event.clearedBlocks,
        strategy: event.strategy,
        microOnly: event.microOnly,
      } as NormalizedEvent)
      return true

    case 'engine_tool_stalled':
      debug('tool_stalled', { tab_id: tabId, tool: event.toolName, elapsed_s: event.toolElapsed })
      ctx.emit('event', tabId, {
        type: 'tool_stalled',
        toolId: event.toolId,
        toolName: event.toolName,
        elapsed: event.toolElapsed,
      } as NormalizedEvent)
      return true

    case 'engine_run_stalled':
      // Advisory watchdog signal. The legacy path only logged this; emit as
      // normalized run_stalled so the renderer can surface a distinct indicator.
      debug('run_stalled', { tab_id: tabId, duration: event.runStalledDuration, last_activity: event.runStalledLastActivity ?? 'unknown' })
      ctx.emit('event', tabId, {
        type: 'run_stalled',
        stalledDuration: event.runStalledDuration,
        lastActivity: event.runStalledLastActivity,
      } as NormalizedEvent)
      return true

    case 'engine_run_recovery':
      log('run_recovery', {
        tab_id: tabId,
        recovery_id: event.runRecoveryId,
        phase: event.runRecoveryPhase,
        attempt: event.runRecoveryAttempt ?? 0,
        max_attempts: event.runRecoveryMaxAttempts ?? 0,
      })
      ctx.emit('event', tabId, {
        type: 'run_recovery',
        recoveryId: event.runRecoveryId,
        phase: event.runRecoveryPhase,
        attempt: event.runRecoveryAttempt,
        maxAttempts: event.runRecoveryMaxAttempts,
        reason: event.runRecoveryReason,
      } as NormalizedEvent)
      return true

    case 'engine_task_suspended':
      // A run ended without completing. Either a dispatched agent called
      // ctx.suspend()/suspendUntilAll() and is parked waiting for child
      // completions or a revive message, or the engine parked a session at a
      // turn boundary on outstanding background bash commands. Forward as a
      // normalized task_suspend so the renderer can show "suspended/idle".
      //
      // The wire event carries COUNTS, not the ID arrays (see
      // EngineEvent.taskSuspendAwaitingCount / …TaskCount). The normalized
      // variant's fields are ID arrays, so there is nothing faithful to put in
      // them here — fabricating placeholder IDs from a count would be worse
      // than omitting them. Both counts are logged instead, which is what
      // makes a parked session distinguishable from a dispatch-suspended one
      // in the log alone.
      debug('task_suspended', {
        tab_id: tabId,
        awaiting_count: event.taskSuspendAwaitingCount ?? 0,
        awaiting_task_count: event.taskSuspendAwaitingTaskCount ?? 0,
      })
      ctx.emit('event', tabId, { type: 'task_suspend' } as NormalizedEvent)
      return true

    case 'engine_steer_injected':
      // Mid-turn steer-drain confirmation. The runloop captures a steer
      // message between turns, inside the end_turn checkpoint, or after
      // tool execution; this event tells consumers the steer landed in
      // the conversation as a user turn before the next LLM call.
      // steerClientMessageId/steerEntryId are additive: present only for a
      // genuine client-originated steer whose sender supplied a correlation
      // id (steerClientMessageId) — the engine always supplies steerEntryId
      // for a genuine client-originated steer regardless of whether the
      // client sent an id, so a client that omitted correlation still learns
      // the durable rewind target.
      log('steer_injected', {
        tab_id: tabId,
        message_length: event.steerMessageLength,
        client_message_id: event.steerClientMessageId ?? '',
        entry_id: event.steerEntryId ?? '',
      })
      ctx.emit('event', tabId, {
        type: 'steer_injected',
        messageLength: event.steerMessageLength,
        ...(event.steerClientMessageId ? { clientMessageId: event.steerClientMessageId } : {}),
        ...(event.steerEntryId ? { entryId: event.steerEntryId } : {}),
      } as NormalizedEvent)
      return true

    case 'engine_steer_degraded':
      // No owning run was live. Preserve the distinct engine semantic so the
      // renderer can append a divider without reconciling live pending steers.
      log('steer_degraded', { tab_id: tabId, message_length: event.steerDegradedMessageLength })
      ctx.emit('event', tabId, {
        type: 'steer_degraded',
        messageLength: event.steerDegradedMessageLength,
      } as NormalizedEvent)
      return true

    case 'engine_prompt_injected':
      // Extension-injected prompt (ctx.sendPrompt): the engine started a run
      // on a user turn no client submitted. Forward the full text so live
      // transcripts can render the turn — without this, clients watch the
      // model respond to a message that exists only in the conversation file.
      //
      // injectedPromptKind classifies the injection and
      // injectedPromptMachineAuthored is the engine's derived verdict on
      // whether an engine-side actor authored it. Both are forwarded; the
      // renderer decides via suppressesInjection (shared/injection-policy.ts).
      // Forwarding only the kind would force the renderer back to matching
      // strings, which is the pattern that kept drifting.
      log('prompt_injected', { tab_id: tabId, prompt_len: event.injectedPrompt?.length ?? 0, origin: event.injectedPromptOrigin ?? '', kind: event.injectedPromptKind ?? '', machine_authored: event.injectedPromptMachineAuthored ?? false })
      ctx.emit('event', tabId, {
        type: 'prompt_injected',
        prompt: event.injectedPrompt,
        origin: event.injectedPromptOrigin,
        kind: event.injectedPromptKind,
        machineAuthored: event.injectedPromptMachineAuthored,
      } as NormalizedEvent)
      return true
  }
  return false
}
