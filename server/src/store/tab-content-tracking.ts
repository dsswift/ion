/**
 * Per-tab change tracking for the external content files (schema v4): the
 * messages array reference of the last write per tab. Content files rewrite
 * in full, so skipping unchanged tabs matters — without this every debounced
 * persist tick would rewrite EVERY tab's content, not just the streaming one.
 * The runtime store replaces the messages array on every mutation (immutable
 * updates), so reference equality is an exact dirty check.
 *
 * Leaf module with no imports: shared by session-store-persistence (writes)
 * and tab-slice (close cleanup) without creating an import cycle through the
 * store/component graph.
 */
const lastWrittenContentRef = new Map<string, unknown>()

/** True when the tab's messages reference changed since the last write. */
export function tabContentDirty(tabId: string, messagesRef: unknown): boolean {
  return lastWrittenContentRef.get(tabId) !== messagesRef
}

/** Record the messages reference just written for a tab. */
export function markTabContentWritten(tabId: string, messagesRef: unknown): void {
  lastWrittenContentRef.set(tabId, messagesRef)
}

/** Drop a closed tab's content-write tracking (called from closeTab). */
export function forgetTabContentTracking(tabId: string): void {
  lastWrittenContentRef.delete(tabId)
}
