// Thinking-channel event handlers extracted from engine-control-plane-events.ts
// (split by event domain to keep every file under the 600-line cap). These are
// the `engine_thinking_block_start`, `engine_thinking_delta`, and
// `engine_thinking_block_end` arms of the EngineEvent→NormalizedEvent
// translation switch, lifted out verbatim. No logic change. The main file
// delegates to handleThinkingEvent from its switch.
import type { EngineEvent, NormalizedEvent } from '../shared/types'
import { log as _log, trace as _trace } from './logger'
import type { EventEmitterContext, TabEntry } from './engine-control-plane-events-types'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function trace(msg: string, fields?: Record<string, unknown>): void { _trace(TAG, msg, fields) }

/**
 * Handle the extended-thinking (issue #158) event arms. Returns true when the
 * event type was one of these arms, false otherwise. Behavior is identical to
 * the former inline cases.
 */
export function handleThinkingEvent(
  ctx: EventEmitterContext,
  tabId: string,
  _tab: TabEntry,
  event: EngineEvent,
): boolean {
  switch (event.type) {
    case 'engine_thinking_block_start':
      // Extended thinking (issue #158), plain-conversation path. The model
      // began a reasoning block. Translate to the normalized-stream
      // `thinking_block_start` so event-slice.ts opens a `role: 'thinking'`
      // row. Boundaries always arrive when reasoning happened; the per-token
      // delta may be suppressed engine-side (summary-only path). Mirrors the
      // extension-hosted path in engine-event-slice.ts.
      log('thinking_block_start', { tab_id: tabId })
      ctx.emit('event', tabId, { type: 'thinking_block_start' } as NormalizedEvent)
      return true

    case 'engine_thinking_delta':
      // Incremental reasoning text — peer of engine_text_delta for the
      // thinking channel. Only arrives when the engine's ThinkingConfig
      // .StreamDeltas is on (boundaries always flow regardless). Translate to
      // the normalized `thinking_delta` so the renderer appends it to the open
      // thinking row. Per-token: logged at TRACE so it is filtered before
      // serialization at the default INFO level (a per-chunk diagnostic, per the
      // desktop logging rule) and does not amplify main-thread load under load.
      trace('thinking_delta', { tab_id: tabId, len: event.thinkingText?.length ?? 0 })
      ctx.emit('event', tabId, {
        type: 'thinking_delta',
        text: event.thinkingText,
      } as NormalizedEvent)
      return true

    case 'engine_thinking_block_end':
      // The reasoning block finished. Carries a summary (elapsed seconds,
      // token estimate, redacted flag) so the renderer can show "💭 Thought
      // for Ns" even when deltas were suppressed. Translate to the normalized
      // `thinking_block_end` so event-slice.ts seals the active thinking row.
      log(
        `thinking_block_end: tabId=${tabId} elapsed=${event.thinkingElapsedSeconds ?? '?'}s ` +
        `tokens=${event.thinkingTotalTokens ?? '?'} redacted=${!!event.thinkingRedacted}`,
      )
      ctx.emit('event', tabId, {
        type: 'thinking_block_end',
        totalTokens: event.thinkingTotalTokens,
        elapsedSeconds: event.thinkingElapsedSeconds,
        redacted: event.thinkingRedacted,
      } as NormalizedEvent)
      return true
  }
  return false
}
