/**
 * Shared type for boot-restore-tab.ts / boot-restore-tabs.ts.
 *
 * Deliberately NOT `RestoredTabRef` from useTabRestoration-helpers.ts (which
 * has no `sessionId`): useTabRestoration-history.ts's `loadRestoredHistory`
 * requires `sessionId` on every entry, so this carries the wider shape the
 * original useTabRestoration.ts always used. It is still a structural
 * superset of `RestoredTabRef`, so it satisfies every function that only
 * needs `tabId`/`index`.
 */
export interface RestoredTabId {
  tabId: string
  sessionId: string | null
  index: number
}
