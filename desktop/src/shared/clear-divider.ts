/**
 * `/clear` checkpoint divider helpers.
 *
 * Shared between the renderer (InputBarCommandHandlers.ts, SystemMessage.tsx,
 * EngineMessageRow rendering) and the main process (slash-intercept.ts,
 * ipc/engine.ts) so the divider text and its sentinel-prefix detection stay
 * in lockstep across both processes.
 *
 * The string `── Cleared at <H:MM AM/PM> ──` is the contract: SystemMessage.tsx
 * (and any future iOS divider styling) switches on the `── Cleared` prefix to
 * render the message as a full-width horizontal rule instead of a normal
 * system-message bubble.
 */

/**
 * Format the divider system message inserted into scrollback after a
 * `/clear` checkpoint.
 */
export function formatClearDivider(at: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `── Cleared at ${time} ──`
}

/** Sentinel-prefix check used by message renderers to switch into divider mode. */
export function isClearDivider(content: string): boolean {
  return content.startsWith('── Cleared')
}

/**
 * Build the `RemoteEvent` envelope used to mirror a `/clear` divider to
 * connected remote (iOS) clients. The envelope kind depends on the engine
 * session key shape:
 *
 *   - `${tabId}:${instanceId}` → engine tab → `engine_harness_message`
 *     (iOS renders this as a role='harness' message with the divider text)
 *   - bare `${tabId}`          → CLI tab    → `message_added` carrying a
 *     role='system' message with the divider text
 *
 * The returned event is one of the union variants in protocol.ts; the
 * caller passes it to `state.remoteTransport.send(...)`. Pure builder
 * (no side effects) so it's straightforward to test.
 */
export function buildClearDividerRemoteEvent(
  key: string,
  at: Date,
):
  | { type: 'engine_harness_message'; tabId: string; instanceId: string; message: string; source: string }
  | { type: 'message_added'; tabId: string; message: { id: string; role: 'system'; content: string; timestamp: number; source: 'desktop' } } {
  const divider = formatClearDivider(at)
  const colonIdx = key.indexOf(':')
  if (colonIdx >= 0) {
    return {
      type: 'engine_harness_message',
      tabId: key.slice(0, colonIdx),
      instanceId: key.slice(colonIdx + 1),
      message: divider,
      source: 'clear',
    }
  }
  return {
    type: 'message_added',
    tabId: key,
    message: {
      id: `clear-${at.getTime()}`,
      role: 'system',
      content: divider,
      timestamp: at.getTime(),
      source: 'desktop',
    },
  }
}
