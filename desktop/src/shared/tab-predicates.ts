/**
 * tab-predicates — derived predicates over TabState.
 *
 * These are the single source of truth for tab classification. All call
 * sites that need to know "does this tab have extensions" route through
 * `tabHasExtensions` instead of reading a stored boolean. The predicate
 * derives from `engineProfileId`: a non-null, non-empty profile id means
 * the tab was created with an engine profile and therefore has extensions.
 *
 * Shared between the main and renderer processes.
 */

/**
 * True when the tab has engine extensions loaded. Derived from the tab's
 * `engineProfileId` field: any non-null, non-empty value indicates the tab
 * was created with a profile that supplies extensions.
 *
 * This replaces the old stored `hasEngineExtension` boolean. The derivation
 * is always consistent because `engineProfileId` is set at tab creation and
 * never changes during the tab's lifetime.
 */
export function tabHasExtensions(tab: { engineProfileId: string | null }): boolean {
  return tab.engineProfileId != null && tab.engineProfileId !== ''
}

/**
 * Same derivation as `tabHasExtensions` but for persisted tab shapes where
 * `engineProfileId` may be absent (pre-Phase 4 tabs.json files). Falls back
 * to the legacy `hasEngineExtension` boolean if `engineProfileId` is not
 * present.
 */
export function persistedTabHasExtensions(st: {
  engineProfileId?: string | null
  hasEngineExtension?: boolean
}): boolean {
  if (st.engineProfileId != null && st.engineProfileId !== '') return true
  return !!st.hasEngineExtension
}

/**
 * True when a persisted tab was settled at shutdown time. Settled tabs restore
 * as cold history records: `inputLocked` + `inputLockReason: 'settled'`, no
 * engine/session bootstrap. The user can un-settle to reactivate.
 *
 * The persisted provenance is sufficient at restore time: both a manual and an
 * automatic stamp restore as the same hard, cold state without consulting the
 * current clock or preferences.
 */
export function isPersistedSettled(tab: {
  settledOverride?: 'settled' | 'active' | 'auto' | null
}): boolean {
  return tab.settledOverride === 'settled' || tab.settledOverride === 'auto'
}

/**
 * Compute the clipboard payload for "Copy session id" against a tab and its
 * active conversation instance, or null when no id is available yet.
 *
 * Pure derivation shared by the conversation context-menu handlers and tests. For an
 * extension-hosted tab the payload is every conversation id the instance knows
 * (historical `conversationIds` plus the live `statusFields.sessionId`), one per
 * line; for a plain tab it is the single tab-level id. Returning null is the
 * "nothing to copy" signal the caller used to express via an early return.
 *
 * Because the engine-minted id is now captured onto these fields at tab-creation
 * time (see engine-slice-create.ts `_captureMintedConversationId`), this yields
 * a real id on a fresh tab — the regression this guards against was an empty
 * payload immediately after tab creation, before any prompt ran.
 */
export interface SessionIdentityTab {
  engineProfileId?: string | null
  historicalSessionIds?: readonly string[]
  conversationId?: string | null
  lastKnownSessionId?: string | null
  sessionIds?: readonly string[]
}

export interface SessionIdentityInstance {
  conversationIds?: readonly string[]
  statusFields?: { sessionId?: string | null } | null
}

/** Merge every known durable and live session id in historical-to-current order. */
export function orderedSessionIds(
  tab: SessionIdentityTab,
  activeInstance?: SessionIdentityInstance | null,
): string[] {
  const ordered = [
    ...(tab.sessionIds ?? []),
    ...(tab.historicalSessionIds ?? []),
    ...(activeInstance?.conversationIds ?? []),
    tab.lastKnownSessionId,
    tab.conversationId,
    activeInstance?.statusFields?.sessionId,
  ]
  const seen = new Set<string>()
  return ordered.filter((id): id is string => typeof id === 'string' && id.length > 0 && !seen.has(id) && !!seen.add(id))
}

export function computeSessionIdCopyPayload(
  tab: SessionIdentityTab,
  activeInstance: SessionIdentityInstance | null,
): string | null {
  const ids = orderedSessionIds(tab, activeInstance)
  return ids.length > 0 ? ids.join('\n') : null
}
