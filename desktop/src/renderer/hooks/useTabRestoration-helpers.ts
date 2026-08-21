import type { ConversationPane, StatusFields } from '../../shared/types-engine'
import type { PersistedTab, PersistedConversationInstance } from '../../shared/types-persistence'
import { migrateTabToUnified } from '../../main/tab-migration-unify'
import { activeInstance, needsHistoryHydration } from '../stores/conversation-instance'
import { isPersistedSettled } from '../../shared/tab-predicates'
import { SESSION_ATTACH_BATCH_SIZE } from '../../shared/session-attach-policy'
import { rDebug, rInfo, rWarn } from '../rendererLogger'

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
 *   1. The `isEngine` → `engineProfileId` derivation (coalesced inside
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
 * The directory a restored tab should actually run in.
 *
 * ── Why this is not simply `tab.workingDirectory` ───────────────────────────
 * The persisted `workingDirectory` can disagree with the tab's own worktree
 * record, and when it does the worktree is right. That disagreement is exactly
 * what a historical create-order defect produced: sessions were started in the
 * base repo before the worktree existed, so five conversations persisted a
 * `workingDirectory` pointing at the shared checkout while carrying a correct
 * `worktree.worktreePath`.
 *
 * The tab-state restore path already resolved this (it prefers the worktree path
 * when the directory still exists, and falls back to the repo when the worktree
 * was cleaned up externally) — but the EAGER SESSION START read the raw
 * persisted value, so a restart put every one of those sessions back in the base
 * repo. Deriving the directory in one function means the tab state and the
 * session it starts cannot disagree.
 *
 * `worktreeExists` is passed in rather than probed here so this stays a pure
 * function: the caller has already probed the directory to decide whether to
 * keep the worktree record at all, and probing twice could return two answers.
 */
export function resolveRestoredWorkingDirectory(
  tab: PersistedTab,
  worktreeExists: boolean,
): string {
  if (tab.worktree) {
    // Active conversations can move back to the source repo after external
    // cleanup. Settled records cannot: they stay bound to their retired
    // worktree forever, and the Inbox restore guard keeps them cold.
    return worktreeExists || isPersistedSettled(tab)
      ? tab.worktree.worktreePath
      : tab.worktree.repoPath
  }
  return tab.workingDirectory
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
 * Recover model-selection provenance from a persisted instance.
 *
 * Pre-provenance files have a model value but cannot prove whether it came from
 * a picker or from automatic mode/workflow selection. Keep that state unknown:
 * slash frontmatter may then choose its model tier. New files preserve the
 * explicit source exactly.
 */
export function restoredModelSelection(
  inst: Pick<PersistedConversationInstance, 'modelOverride' | 'modelOverrideSource'> | null | undefined,
): { modelOverride: string | null; modelOverrideSource: 'user' | 'automatic' | null } {
  return {
    modelOverride: inst?.modelOverride || null,
    modelOverrideSource: inst?.modelOverride ? (inst.modelOverrideSource ?? null) : null,
  }
}

/**
 * Seed the persisted context-occupancy scalars back onto a restored
 * instance's `statusFields`.
 *
 * The status-bar indicator reads `statusFields.contextTokens`, so without
 * this a cold-started tab renders no context reading at all until the first
 * engine status event lands — a "count that updates after the user sees it",
 * which the view-readiness principle forbids. Only the two context scalars
 * are restored; the rest of `statusFields` (state, label, denials) is
 * live-only and a persisted copy would be stale by construction.
 *
 * Returns an empty object when nothing was persisted, so callers can spread
 * it unconditionally into an instance patch.
 */
export function seedContextStatusFields(
  inst: { statusFields?: StatusFields | null },
  main: PersistedConversationInstance | null,
): { statusFields?: StatusFields } {
  if (!main?.contextTokens && !main?.contextWindow) return {}
  const base: StatusFields = inst.statusFields ?? {
    label: '',
    state: 'idle',
    model: '',
    contextPercent: 0,
    contextWindow: 0,
  }
  return {
    statusFields: {
      ...base,
      ...(main.contextTokens ? { contextTokens: main.contextTokens } : {}),
      ...(main.contextWindow ? { contextWindow: main.contextWindow } : {}),
    },
  }
}

/**
 * Resolve the plan file path to forward on a `tab_restore` permission-mode
 * re-assert. Returns the instance's `planFilePath` only when restoring into
 * plan mode (the engine ignores it on 'auto', and forwarding it there would be
 * misleading). undefined when not in plan mode or no path persisted.
 *
 * Used by all three plain-tab restore paths (active / skeleton / sessionless)
 * so the engine re-adopts the conversation's existing plan instead of
 * allocating a fresh slug on the next plan-mode prompt. Pure helper so the
 * three call sites share one rule and stay under the file-size cap.
 */
export function planPathForRestore(
  mode: 'auto' | 'plan',
  inst: PersistedConversationInstance | null,
): string | undefined {
  return mode === 'plan' ? (inst?.planFilePath || undefined) : undefined
}

/**
 * Re-assert a restored tab's permission mode to the engine, forwarding the
 * persisted plan file path so plan-mode continuity survives restart. Resolves
 * the mode from the instance (falling back to the legacy tab-level field for
 * pre-WI-002 saves), then sends `setPermissionMode(..., 'tab_restore', path)`.
 * Centralizes the three plain-tab restore call sites (active / skeleton /
 * sessionless) behind one rule.
 */
export function reassertRestoredPlanMode(
  tabId: string,
  inst: PersistedConversationInstance | null,
  legacyTabMode: 'auto' | 'plan' | undefined,
): void {
  const mode: 'auto' | 'plan' = inst?.permissionMode ?? legacyTabMode ?? 'auto'
  window.ion.setPermissionMode(tabId, mode, 'tab_restore', planPathForRestore(mode, inst))
}

/**
 * Read the conversation instances from a unified extension-hosted tab. Used by
 * the engine-tab restore path, which previously read the `engine*` maps.
 */
export function readConversationInstances(tab: PersistedTab): PersistedConversationInstance[] {
  return tab.conversationPane?.instances ?? []
}

// ─── Bounded eager session-start ordering (daemon-model compatibility) ───────
//
// The engine is a shared launchd daemon (not a fresh per-desktop child). On
// restore the desktop starts the active tab first, then attaches the remaining
// sessions in bounded batches. The cap protects the daemon dispatch goroutine
// and event queue while removing unnecessary sequential startup delay.

/** A restored tab id paired with its index into the persisted tabs array. */
export interface RestoredTabRef {
  tabId: string
  index: number
}

/**
 * Order eager-session-start candidates: the active tab first, then the
 * remaining candidates in their original order. Stable (preserves input order
 * within each group). Pure — does not start anything.
 *
 * `activeIdx` is `saved.activeTabIndex ?? -1`; when it does not match any
 * candidate, the input order is preserved unchanged.
 */
export function orderSessionCandidates<T extends RestoredTabRef>(
  candidates: T[],
  activeIdx: number,
): T[] {
  return [
    ...candidates.filter(({ index }) => index === activeIdx),
    ...candidates.filter(({ index }) => index !== activeIdx),
  ]
}

/**
 * Start items in bounded batches. Each batch completes before the next starts.
 * The caller orders its active item first, so the active attach is dispatched
 * first in the first batch. A rejected item does not prevent later attaches.
 *
 * `onProgress` runs after every completed item, including failures. It gives the
 * splash screen an exact completed count rather than an inferred timer state.
 */
export async function startSessionsInBatches<T>(
  items: T[],
  start: (item: T) => Promise<void>,
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  let completed = 0
  for (let i = 0; i < items.length; i += SESSION_ATTACH_BATCH_SIZE) {
    const batch = items.slice(i, i + SESSION_ATTACH_BATCH_SIZE)
    await Promise.all(batch.map(async (item) => {
      try {
        await start(item)
      } catch {
        // Individual-start failures are logged by `start`; preserve the batch.
      } finally {
        completed++
        onProgress?.(completed, items.length)
      }
    }))
  }
}

/**
 * Resolve which restored tab should be active at boot: activeTabIndex first,
 * activeSessionId as the backwards-compat fallback. Pure — returns the tabId
 * or null when no persisted active tab matches a restored one.
 */
export function resolveBootActiveTabId(
  saved: { activeTabIndex?: number | null; activeSessionId?: string | null },
  restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }>,
): string | null {
  if (typeof saved.activeTabIndex === 'number') {
    const entry = restoredTabIds.find((r) => r.index === saved.activeTabIndex)
    if (entry) return entry.tabId
  }
  if (saved.activeSessionId) {
    const entry = restoredTabIds.find((r) => r.sessionId === saved.activeSessionId)
    if (entry) return entry.tabId
  }
  return null
}

/**
 * Populate repo-scoped worktree and bench caches before restored UI becomes
 * visible. Worktree tabs carry their owner directly; bench tabs deliberately do
 * not, so main resolves their directory against persisted workspace records.
 * Ordinary directories have no workspace cache to hydrate and remain untouched.
 */
export async function hydrateBootWorkspace(
  tab: Pick<PersistedTab, 'workingDirectory' | 'worktree'> | undefined,
  refreshWorkspaceViews: (repoPath: string) => Promise<void>,
  resolveBenchPath: (directory: string) => Promise<{ workspace: { repoPath: string; sourceBranch: string } | null }>,
): Promise<void> {
  if (!tab?.workingDirectory) {
    rDebug('restore', 'boot workspace hydration skipped: no active directory')
    return
  }

  let repoPath = tab.worktree?.repoPath ?? null
  let source = repoPath ? 'worktree' : 'directory'
  if (!repoPath) {
    try {
      const { workspace } = await resolveBenchPath(tab.workingDirectory)
      repoPath = workspace?.repoPath ?? null
      source = workspace ? 'bench' : 'directory'
      if (workspace) {
        rInfo('restore', 'resolved boot-active bench workspace', {
          directory: tab.workingDirectory,
          repo_path: workspace.repoPath,
          source_branch: workspace.sourceBranch,
        })
      }
    } catch (err) {
      rWarn('restore', 'boot bench resolution failed', {
        directory: tab.workingDirectory,
        error: String(err),
      })
      return
    }
  }

  if (!repoPath) {
    rDebug('restore', 'boot workspace hydration skipped: directory has no workspace identity', {
      directory: tab.workingDirectory,
    })
    return
  }

  rInfo('restore', 'hydrating boot-active workspace views', {
    directory: tab.workingDirectory,
    repo_path: repoPath,
    identity_source: source,
  })
  await refreshWorkspaceViews(repoPath)
  rInfo('restore', 'hydrated boot-active workspace views', {
    repo_path: repoPath,
    identity_source: source,
  })
}

/**
 * Hydrate the boot-active tab's history. The boot-active tab is activated via
 * a raw `setState({ activeTabId })` — selectTab never runs for it, so
 * selectTab's lazy-hydration trigger never fires. Without this explicit call, a
 * boot-active tab whose instance is pending/skeleton renders only its live tail
 * (e.g. one bootstrap harness row) and its real history is never loaded.
 * Applies the same gate selectTab uses (conversationId + needsHistoryHydration).
 */
export async function hydrateBootActiveTab(
  s: {
    tabs: Array<{ id: string; conversationId: string | null }>
    conversationPanes: Map<string, ConversationPane>
    loadSkeletonMessages: (tabId: string) => Promise<void>
  },
  tabId: string,
): Promise<void> {
  const tab = s.tabs.find((t) => t.id === tabId)
  const inst = activeInstance(s.conversationPanes, tabId)
  if (tab?.conversationId && needsHistoryHydration(inst)) {
    rInfo('restore', 'hydrating boot-active tab', { tab_id: tabId.slice(0, 8) })
    await s.loadSkeletonMessages(tabId)
  }
}

/**
 * Resolve the input-lock fields for a restored tab. Consolidates the
 * priority chain: settled > landed-worktree > persisted reason.
 *
 * Shared by the plain-tab skeleton, active-tab, sessionless, and engine-tab
 * restore paths so the rule is expressed once.
 */
export function resolvedInputLock(st: PersistedTab, worktree?: { landedAt?: number } | null): {
  inputLocked: boolean
  inputLockReason: 'automated-workflow' | 'landed-worktree' | 'settled' | null
} {
  if (isPersistedSettled(st)) {
    return { inputLocked: true, inputLockReason: 'settled' }
  }
  if (worktree?.landedAt) {
    return { inputLocked: true, inputLockReason: 'landed-worktree' }
  }
  return {
    inputLocked: st.inputLocked ?? false,
    inputLockReason: (st.inputLockReason as 'automated-workflow' | 'landed-worktree' | 'settled' | null) ?? null,
  }
}
