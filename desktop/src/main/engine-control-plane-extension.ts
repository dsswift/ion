// Extension-lifecycle / harness event handlers extracted from
// engine-control-plane-events.ts (split by event domain to keep every file
// under the 600-line cap). These are the `engine_extension_died`,
// `engine_extension_respawned`, `engine_extension_dead_permanent`,
// `engine_harness_message`, `engine_events_dropped`, `engine_model_fallback`,
// `engine_capability_unsupported`,
// and `engine_intercept` arms of the EngineEvent→NormalizedEvent translation
// switch, lifted out verbatim. No logic change. The main file delegates to
// handleExtensionEvent from its switch.
import type { EngineEvent, NormalizedEvent } from '../shared/types'
import { log as _log } from './logger'
import type { EventEmitterContext, TabEntry } from './engine-control-plane-events-types'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Handle the extension-lifecycle / harness event arms. Returns true when the
 * event type was one of these arms, false otherwise. Behavior is identical to
 * the former inline cases.
 */
export function handleExtensionEvent(
  ctx: EventEmitterContext,
  tabId: string,
  _tab: TabEntry,
  event: EngineEvent,
): boolean {
  switch (event.type) {
    case 'engine_harness_message':
      // Extension harness display message (e.g. welcome banner). Emit as
      // normalized harness_message so event-slice.ts can apply dedup logic
      // and append to the active instance's messages.
      ctx.emit('event', tabId, {
        type: 'harness_message',
        message: event.message || '',
        dedupKey: (event.metadata as any)?.dedupKey || undefined,
        dedupMode: (event.metadata as any)?.dedupMode || undefined,
        source: event.source,
      } as NormalizedEvent)
      return true

    case 'engine_extension_died':
      ctx.emit('event', tabId, {
        type: 'extension_died',
        extensionName: event.extensionName || '',
      } as NormalizedEvent)
      return true

    case 'engine_extension_respawned':
      ctx.emit('event', tabId, {
        type: 'extension_respawned',
        extensionName: event.extensionName || '',
        attemptNumber: event.attemptNumber || 0,
      } as NormalizedEvent)
      return true

    case 'engine_extension_dead_permanent':
      ctx.emit('event', tabId, {
        type: 'extension_dead_permanent',
        extensionName: event.extensionName || '',
        attemptNumber: event.attemptNumber || 0,
      } as NormalizedEvent)
      return true

    case 'engine_events_dropped':
      ctx.emit('event', tabId, {
        type: 'events_dropped',
        count: event.count || 0,
      } as NormalizedEvent)
      return true

    case 'engine_model_fallback':
      // Model fallback workflow signal. Emit as normalized model_fallback
      // so event-slice.ts can set the engineModelFallbacks indicator.
      ctx.emit('event', tabId, {
        type: 'model_fallback',
        requestedModel: event.fallbackRequestedModel || '',
        fallbackModel: event.fallbackModel || '',
        reason: event.fallbackReason || '',
      } as NormalizedEvent)
      return true

    case 'engine_capability_unsupported':
      // Declined feature request (e.g. plan mode on a backend without one).
      // The engine never started a run and the session stays idle; emit as
      // normalized capability_unsupported so event-slice can render the
      // recoverable message and settle the tab back to idle.
      log('capability_unsupported', {
        tab_id: tabId,
        capability: event.capability,
        backend: event.capabilityBackend,
      })
      ctx.emit('event', tabId, {
        type: 'capability_unsupported',
        capability: event.capability || '',
        backend: event.capabilityBackend || '',
        reason: event.capabilityReason || '',
      } as NormalizedEvent)
      return true

    case 'engine_intercept':
      // Fire-and-forget signal: bubble up via ctx.emit so event-wiring.ts's
      // wireSessionPlaneEvents can call handleInterceptEvent without creating
      // a circular import through state.ts. The event carries the raw payload
      // and tabId; the wiring layer in event-wiring.ts does the routing.
      log('intercept', { tab_id: tabId, level: event.interceptLevel, title: event.interceptTitle })
      ctx.emit('engine_intercept', tabId, event)
      return true
  }
  return false
}
