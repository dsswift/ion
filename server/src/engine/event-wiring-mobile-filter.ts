/**
 * Which engine events a mobile client is sent.
 *
 * Every engine event is forwarded to a paired mobile client, with two classes
 * held back:
 *
 *  - Studio's own resource traffic: a control resource (kind `ion-studio.*`),
 *    which an extension sends to Ion Studio, such as a Composer Action; and
 *    the operator focus Studio publishes for extensions. A mobile client has
 *    no surface for either and lists every workspace resource it receives as
 *    a notification, so sending one would put it in someone's inbox.
 *
 *  - An event whose only effect on a client is a transcript row. A thin client
 *    receives the server store's own transcript (transcript-publisher.ts), so
 *    the rows these events build already reach it, built once, by the same
 *    reducer Studio renders from. Forwarding the raw event as well is what let
 *    the phone build a second copy that drifted from the first.
 */
import { isStudioTrafficKind } from '@ion/shared/studio-sdk-contract'

export function isStudioOnlyEngineEvent(event: { type?: string; resourceKind?: string }): boolean {
  return typeof event.type === 'string' && event.type.startsWith('engine_resource_') && isStudioTrafficKind(event.resourceKind)
}

/**
 * Engine events a thin client receives as transcript rows rather than as
 * events. Each one's effect on a client is the row the store's reducer makes
 * from it; nothing else a client shows depends on it.
 */
export const TRANSCRIPT_ONLY_ENGINE_EVENTS: ReadonlySet<string> = new Set([
  'engine_text_delta',
  'engine_tool_start',
  'engine_tool_update',
  'engine_tool_end',
  'engine_stream_reset',
  'engine_thinking_block_start',
  'engine_thinking_delta',
  'engine_thinking_block_end',
  'engine_image_content',
  'engine_harness_message',
  'engine_notify',
  'engine_plan_file_written',
  'engine_steer_injected',
  'engine_steer_degraded',
  'engine_prompt_injected',
  'engine_user_turn_persisted',
  'engine_assistant_turn_persisted',
  'engine_run_recovery',
  'engine_dispatch_lost',
  'engine_dispatch_activity',
  // A branch switch replaces the whole transcript (active-path-reload.ts).
  'engine_active_path_changed',
])

export function isTranscriptOnlyEngineEvent(event: { type?: string }): boolean {
  return typeof event.type === 'string' && TRANSCRIPT_ONLY_ENGINE_EVENTS.has(event.type)
}
