/**
 * session-key — the single source of truth for engine session keys.
 *
 * Every tab in the system is addressed by ONE key shape: the compound
 * `${tabId}:${instanceId}`. Normal (non-extension) tabs are single-instance
 * and use the stable sentinel instance id `main`, so their key is
 * `${tabId}:main`. Engine tabs use their per-instance ids.
 *
 * Why one shape: a dual key shape (bare `tabId` for normal tabs, compound for
 * engine tabs) forced every consumer to branch on `key.includes(':')` —
 * roughly 40 sites across the desktop. Each branch is a place where the two
 * paths can (and did) diverge. A single key shape removes the branches: code
 * builds and parses keys through these helpers and never special-cases tab
 * type again.
 *
 * Shared between the main and renderer processes so both sides construct and
 * parse keys identically.
 */

/**
 * Stable instance id for a normal (single-instance) tab. Chosen as a fixed
 * sentinel rather than a random id so the same tab always maps to the same
 * key across reloads and app restarts — no per-load drift. `tabId` is already
 * globally unique, so `${tabId}:main` is unique without needing a random
 * instance segment.
 */
export const MAIN_INSTANCE_ID = 'main'

/** Build the compound session key for a tab + instance. */
export function sessionKey(tabId: string, instanceId: string = MAIN_INSTANCE_ID): string {
  return `${tabId}:${instanceId}`
}

/**
 * Parse a compound session key into its tabId + instanceId. Tolerant of a
 * legacy bare-tabId key (no ':') by treating the whole string as the tabId
 * with the `main` instance — this keeps any not-yet-migrated caller working
 * during the transition without re-introducing a branch at the call site.
 */
export function parseSessionKey(key: string): { tabId: string; instanceId: string } {
  const idx = key.indexOf(':')
  if (idx < 0) return { tabId: key, instanceId: MAIN_INSTANCE_ID }
  return { tabId: key.slice(0, idx), instanceId: key.slice(idx + 1) }
}

/** Extract just the tabId from a compound (or legacy bare) session key. */
export function tabIdFromKey(key: string): string {
  return parseSessionKey(key).tabId
}

/** Extract just the instanceId from a compound (or legacy bare) session key. */
export function instanceIdFromKey(key: string): string {
  return parseSessionKey(key).instanceId
}

/**
 * True iff `key` carries an explicit instance segment (`${tabId}:${instanceId}`),
 * i.e. it is NOT a bare `tabId`.
 *
 * This exists for the renderer's two STREAM DISCRIMINATORS in
 * engine-event-slice.ts / engine-event-slice-messages.ts. Those sites are NOT
 * branching on tab type or key shape for addressing — they separate the raw
 * extension event stream (keyed `${tabId}:${instanceId}`, drives extension-
 * hosted instances) from a plain conversation's raw events (keyed bare `tabId`,
 * already handled via the normalized stream). Using a named predicate makes the
 * intent explicit instead of an inline `includes(':')` that reads like leftover
 * dual-key-shape cruft. Pane ADDRESSING never uses this — it uses
 * `parseSessionKey`, which tolerates the bare form.
 */
export function isCompoundKey(key: string): boolean {
  return key.indexOf(':') >= 0
}
