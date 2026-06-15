import type { ConversationPane } from '../../shared/types-engine'
import type { PersistedTab, PersistedConversationInstance } from '../../shared/types-persistence'
import { migrateTabToUnified } from '../../main/tab-migration-unify'
import { activeInstance } from '../stores/conversation-instance'

/**
 * Pure helpers extracted from useTabRestoration.ts to keep that hook under the
 * 600-line TypeScript cap. These are restoration-time utilities with no React
 * dependency.
 */

/** Parse a JSON toolInput string into a Record, or undefined on failure. */
export function parseToolInput(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Skeleton (lazy-load) detection, post per-instance refactor. The old code
 * keyed off `tab.messages === null`; messages now live on the tab's `main`
 * ConversationInstance and are typed non-nullable (`[]` when unloaded). A
 * skeleton tab is therefore one whose active instance has an empty scrollback
 * but a positive persisted `messageCount` — i.e. there is history on disk that
 * hasn't been hydrated yet. Such tabs defer all message loading to on-demand
 * `loadSkeletonMessages`, so the bulk restore loops skip them.
 */
export function isSkeletonTab(
  conversationPanes: Map<string, ConversationPane>,
  tabId: string,
): boolean {
  const inst = activeInstance(conversationPanes, tabId)
  if (!inst) return false
  return inst.messages.length === 0 && (inst.messageCount ?? 0) > 0
}

/**
 * Normalize freshly-loaded persisted tabs to the unified shape IN MEMORY before
 * restoration reads them.
 *
 * Two layers of back-compat collapse here:
 *   1. The `isEngine` → `hasEngineExtension` rename (coalesced inside
 *      `migrateTabToUnified`).
 *   2. The split persisted shape (flat plain-tab fields + `engine*` maps) →
 *      the unified `conversationPane`. `migrateTabToUnified` is the SAME pure
 *      transform the on-disk migration uses, run here so restoration always
 *      reads `conversationPane`, regardless of whether the on-disk file was
 *      already migrated (idempotent: an already-unified tab passes through).
 *
 * This is the read-side safety net: even if the on-disk migration was skipped
 * (verify failure, downgrade, a `.prev` file that escaped migration), the tab
 * is unified in memory so the rest of restoration has one code path.
 *
 * Returns a NEW array of unified tabs (does not mutate the input).
 */
export function normalizeLegacyTabFields(tabs: PersistedTab[]): PersistedTab[] {
  return tabs.map(migrateTabToUnified)
}

/**
 * Read the plain-conversation `main` instance fields from a unified tab. Used by
 * the plain-tab restore path, which previously read flat fields off the tab.
 */
export function readMainInstance(tab: PersistedTab): PersistedConversationInstance | null {
  const pane = tab.conversationPane
  if (!pane || pane.instances.length === 0) return null
  return pane.instances.find((i) => i.id === 'main') ?? pane.instances[0]
}

/**
 * Read the conversation instances from a unified extension-hosted tab. Used by
 * the engine-tab restore path, which previously read the `engine*` maps.
 */
export function readConversationInstances(tab: PersistedTab): PersistedConversationInstance[] {
  return tab.conversationPane?.instances ?? []
}

