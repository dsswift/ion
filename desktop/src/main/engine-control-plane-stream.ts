// Mid-run stream-signal event handlers extracted from
// engine-control-plane-events.ts (split by event domain to keep every file
// under the 600-line cap). These are the `engine_stream_reset`,
// `engine_compacting`, `engine_tool_stalled`, `engine_run_stalled`, and
// `engine_steer_injected` arms of the EngineEvent→NormalizedEvent translation
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

    case 'engine_steer_injected':
      // Mid-turn steer-drain confirmation. The runloop captures a steer
      // message between turns, inside the end_turn checkpoint, or after
      // tool execution; this event tells consumers the steer landed in
      // the conversation as a user turn before the next LLM call.
      log('steer_injected', { tab_id: tabId, message_length: event.steerMessageLength })
      ctx.emit('event', tabId, {
        type: 'steer_injected',
        messageLength: event.steerMessageLength,
      } as NormalizedEvent)
      return true

    case 'engine_prompt_injected':
      // Extension-injected prompt (ctx.sendPrompt): the engine started a run
      // on a user turn no client submitted. Forward the full text so live
      // transcripts can render the turn — without this, clients watch the
      // model respond to a message that exists only in the conversation file.
      log('prompt_injected', { tab_id: tabId, prompt_len: event.injectedPrompt?.length ?? 0, origin: event.injectedPromptOrigin ?? '' })
      ctx.emit('event', tabId, {
        type: 'prompt_injected',
        prompt: event.injectedPrompt,
        origin: event.injectedPromptOrigin,
      } as NormalizedEvent)
      return true
  }
  return false
}
