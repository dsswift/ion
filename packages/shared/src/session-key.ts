/**
 * session-key — the single source of truth for engine session keys.
 *
 * After Phase 4b (#256), the session key is the BARE tabId. The old
 * compound `${tabId}:main` shape is gone. The engine treats keys as
 * opaque, so this is invisible to the engine.
 *
 * `parseSessionKey` tolerates the legacy `:main` suffix so persisted
 * data and in-flight events from older sessions load correctly.
 *
 * Terminal instances still use `${tabId}:${instanceId}` keys where the
 * instanceId is the terminal instance's own id (not 'main'). Those keys
 * are NOT built through `sessionKey()` and are not affected by this
 * collapse.
 *
 * Shared between the main and renderer processes.
 */

/**
 * Stable instance id for a normal (single-instance) tab. Retained for
 * pane/instance lookup (the `main` instance still exists in the pane's
 * instances array). Not used for key building.
 */
export const MAIN_INSTANCE_ID = 'main'

/**
 * Build the session key for a tab. Returns the bare tabId. The optional
 * instanceId parameter is accepted for call-site compatibility but
 * ignored (all conversation instances use 'main').
 */
export function sessionKey(tabId: string, _instanceId?: string): string {
  return tabId
}

/**
 * Parse a session key. Handles both the new bare-tabId format and legacy
 * compound `tabId:instanceId` keys (strips the instanceId segment). This
 * tolerance ensures persisted data, in-flight events, and test fixtures
 * that carry the old compound shape continue to work.
 */
export function parseSessionKey(key: string): { tabId: string; instanceId: string } {
  const idx = key.indexOf(':')
  if (idx < 0) return { tabId: key, instanceId: MAIN_INSTANCE_ID }
  return { tabId: key.slice(0, idx), instanceId: key.slice(idx + 1) }
}

/** Extract just the tabId from a session key (strips any :instanceId suffix). */
export function tabIdFromKey(key: string): string {
  return parseSessionKey(key).tabId
}

/**
 * Extract the instanceId from a session key. Returns 'main' for bare keys.
 */
export function instanceIdFromKey(key: string): string {
  return parseSessionKey(key).instanceId
}
