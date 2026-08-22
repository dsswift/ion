/**
 * event-wiring-wire-projection — engine-event → desktop wire-event projection.
 *
 * Extracted from event-wiring.ts (file-size cap) at the natural seam: the
 * pure mapping from a raw engine event to the desktop_ wire envelope iOS
 * decodes. No transport, no state — callers hand the already-split tabId /
 * instanceId in and send the returned envelope. Pure functions, unit-testable
 * without the engineBridge harness.
 */

/**
 * Map engine event type strings to desktop_ wire event types. Most engine_*
 * events strip the engine_ prefix and add desktop_ (e.g. engine_status →
 * desktop_status). Exceptions preserve the engine_ segment in the output name
 * so iOS decoders stay unambiguous.
 */
export function engineToWireType(engineType: string): string {
  switch (engineType) {
    case 'engine_error':    return 'desktop_engine_error'
    case 'engine_profiles': return 'desktop_engine_profiles'
    default:                return `desktop_${engineType.replace('engine_', '')}`
  }
}

/**
 * Build the wire envelope for one engine event.
 *
 * Two event types need an EXPLICIT projection because their raw engine field
 * names do not match the wire contract (protocol.ts), and iOS's decoder
 * requires the contract names — a blind spread ships the wrong keys, the
 * decode throws, and the frame is silently dropped on the phone:
 *
 *  - engine_tool_stalled: engine carries `toolElapsed`; the contract declares
 *    `elapsed`. Pre-fix the decode threw ("Key 'elapsed' not found") and
 *    triggered a full resync on every stalled-tool tick. Mirrors the renderer
 *    mapping in engine-control-plane-stream.ts (elapsed: event.toolElapsed).
 *  - engine_image_content: engine carries image-prefixed names (imagePath /
 *    imageMediaType / imageSource / imageToolId — prefixed in engine_event.go
 *    to avoid colliding with other variants' primitives); the contract
 *    declares path / mediaType / source / toolId. Pre-fix the decode threw
 *    ("Key 'path' not found") and provider-generated images never rendered on
 *    iOS — the run's revised-prompt text arrived alone, reading like a bare
 *    echo of the user's message. Mirrors the renderer-side mapping in
 *    engine-control-plane-events.ts (path: event.imagePath).
 *
 * Every other event type forwards via the generic spread. Spread order
 * matters: `...event` carries the engine's own `type: 'engine_*'`, so it MUST
 * come BEFORE the computed wire type or it clobbers it back to the raw
 * `engine_*` name (iOS decoders key off `desktop_*` — see NormalizedEvent.swift
 * TypeKey — so a clobbered type fails to decode and the event is silently
 * dropped on the phone). tabId / instanceId likewise come last so an
 * engine-supplied tabId on the payload can't override the wire-key-derived
 * split.
 */
export function projectEngineEventToWire(
  event: any,
  tabId: string,
  instanceId: string | null,
): Record<string, unknown> {
  if (event.type === 'engine_tool_stalled') {
    return {
      type: 'desktop_tool_stalled',
      tabId,
      instanceId,
      toolId: event.toolId,
      toolName: event.toolName,
      elapsed: event.toolElapsed,
    }
  }
  if (event.type === 'engine_image_content') {
    return {
      type: 'desktop_image_content',
      tabId,
      instanceId,
      path: event.imagePath,
      mediaType: event.imageMediaType,
      source: event.imageSource,
      ...(event.imageContentHash ? { contentHash: event.imageContentHash } : {}),
      ...(event.imageToolId ? { toolId: event.imageToolId } : {}),
    }
  }
  if (event.type === 'engine_background_task_started') {
    return {
      type: 'desktop_background_task_started',
      tabId,
      instanceId,
      task: event.backgroundTaskStarted,
    }
  }
  if (event.type === 'engine_background_task_terminal') {
    return {
      type: 'desktop_background_task_terminal',
      tabId,
      instanceId,
      ...event.backgroundTaskTerminal,
    }
  }
  if (event.type === 'engine_session_work_stopped') {
    return {
      type: 'desktop_session_work_stopped',
      tabId,
      instanceId,
      ...event.sessionWorkStopped,
    }
  }
  return { ...event, tabId, instanceId, type: engineToWireType(event.type) }
}
