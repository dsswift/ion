/**
 * Scrollback divider helpers (session-start, plan-created, implement, /clear).
 *
 * Shared between the renderer (InputBarCommandHandlers.ts, SystemMessage.tsx,
 * EngineMessageRow rendering) and the main process (slash-intercept.ts,
 * ipc/engine.ts) so the divider text and its sentinel-prefix detection stay
 * in lockstep across both processes.
 *
 * Each divider follows the pattern `── <Label> at <H:MM AM/PM> ──` and is
 * rendered by SystemMessage.tsx (and any future iOS divider styling) as a
 * full-width horizontal rule instead of a normal system-message bubble.
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
 * Format the divider system message inserted into scrollback when the user
 * clicks "Implement" on a plan. Mirrors `formatClearDivider` but signals an
 * implementation-phase transition rather than a `/clear` checkpoint. If `slug`
 * is provided it is appended after a ` · ` separator (same shape as the
 * plan-created / plan-updated dividers) so the user can identify which plan is
 * being implemented and the renderer can make the slug a clickable link.
 */
export function formatImplementDivider(at: Date, slug?: string): string {
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (slug) {
    return `── Implementing plan at ${time} · ${slug} ──`
  }
  return `── Implementing plan at ${time} ──`
}

/** Sentinel-prefix check for implement dividers. */
export function isImplementDivider(content: string): boolean {
  return content.startsWith('── Implementing plan')
}

/**
 * Extract the human-readable slug portion of a plan file path: the basename
 * minus the trailing `.md` extension. Mirrors the engine's PlanSlugFromPath
 * (engine/internal/types/normalized_event.go) so the implement divider shows
 * the same slug the engine puts on the plan-created / plan-updated dividers.
 * Empty/undefined path → empty string.
 */
export function planSlugFromPath(path?: string | null): string {
  if (!path) return ''
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

/**
 * Format the divider system message inserted into scrollback when a new
 * session begins (e.g. after app launch or reconnection).
 */
export function formatSessionStartDivider(at: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `── Session started at ${time} ──`
}

/**
 * Format the divider system message inserted into scrollback when a new
 * plan is created.  If `slug` is provided it is appended after a ` · `
 * separator so the user can identify which plan the divider refers to.
 */
export function formatPlanCreatedDivider(at: Date, slug?: string): string {
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (slug) {
    return `── Plan created at ${time} · ${slug} ──`
  }
  return `── Plan created at ${time} ──`
}

/** Sentinel-prefix check for plan-created dividers. */
export function isPlanCreatedDivider(content: string): boolean {
  return content.startsWith('── Plan created')
}

/**
 * Format the divider system message inserted into scrollback when an
 * EXISTING plan is written again (a subsequent plan-mode entry for the same
 * plan file). Mirrors `formatPlanCreatedDivider` but signals an update of the
 * same plan rather than the first creation. The created-vs-updated decision is
 * made by the consumer: the first divider for a given plan path is "created",
 * any subsequent divider for the same path is "updated".
 */
export function formatPlanUpdatedDivider(at: Date, slug?: string): string {
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (slug) {
    return `── Plan updated at ${time} · ${slug} ──`
  }
  return `── Plan updated at ${time} ──`
}

/** Sentinel-prefix check for plan-updated dividers. */
export function isPlanUpdatedDivider(content: string): boolean {
  return content.startsWith('── Plan updated')
}

/**
 * Format the divider system message inserted into scrollback when the
 * engine confirms a mid-turn steer message was injected into the
 * conversation. `messageLength` is included so the user can distinguish
 * a one-word nudge from a multi-sentence steer at a glance.
 */
export function formatSteerAppliedDivider(at: Date, messageLength: number): string {
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `── Steer applied at ${time} · ${messageLength} chars ──`
}

/** Sentinel-prefix check for steer-applied dividers. */
export function isSteerAppliedDivider(content: string): boolean {
  return content.startsWith('── Steer applied')
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
  | { type: 'desktop_harness_message'; tabId: string; instanceId: string; message: string; source: string }
  | { type: 'desktop_message_added'; tabId: string; message: { id: string; role: 'system'; content: string; timestamp: number; source: 'desktop' } } {
  return buildDividerRemoteEvent(key, formatClearDivider(at), at)
}

/**
 * Generalized remote-event builder for any divider content string.
 *
 * Works identically to `buildClearDividerRemoteEvent` but accepts an
 * arbitrary pre-formatted divider `content` instead of deriving it from
 * `formatClearDivider`.  This allows session-start, plan-created, and
 * implement dividers to reuse the same envelope logic.
 *
 * The `key` parameter determines the event shape:
 *
 *   - `${tabId}:${instanceId}` → `desktop_harness_message`
 *   - bare `${tabId}`          → `desktop_message_added`
 */
export function buildDividerRemoteEvent(
  key: string,
  content: string,
  at: Date,
):
  | { type: 'desktop_harness_message'; tabId: string; instanceId: string; message: string; source: string }
  | { type: 'desktop_message_added'; tabId: string; message: { id: string; role: 'system'; content: string; timestamp: number; source: 'desktop' } } {
  const colonIdx = key.indexOf(':')
  if (colonIdx >= 0) {
    return {
      type: 'desktop_harness_message',
      tabId: key.slice(0, colonIdx),
      instanceId: key.slice(colonIdx + 1),
      message: content,
      source: 'clear',
    }
  }
  return {
    type: 'desktop_message_added',
    tabId: key,
    message: {
      id: `clear-${at.getTime()}`,
      role: 'system',
      content,
      timestamp: at.getTime(),
      source: 'desktop',
    },
  }
}
