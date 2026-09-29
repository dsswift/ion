/**
 * session-store-force-flush — an in-process handoff so `event-slice.ts` can
 * force an immediate tab persist on session-id capture without importing
 * `session-store-persistence.ts` directly (that would create an import cycle:
 * persistence already depends on the composed store's action surface, which
 * includes the event slice). The desktop renderer stood this in with a
 * `window.__ionForceFlushTabs` global; the server has no `window`, and the
 * global was never anything but an in-process function reference, so a plain
 * module-level registration replaces it directly.
 */
let flush: (() => void) | null = null

/** Registered once by `setupPersistence` when it starts watching the store. */
export function registerForceFlushTabs(fn: () => void): void {
  flush = fn
}

/** No-op before `setupPersistence` has run. */
export function forceFlushTabs(): void {
  flush?.()
}
