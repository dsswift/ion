/**
 * hydrate-tabs — pure mapping from the owner-published tabs snapshot
 * (PersistedTabState, the same shape the owner persists to disk) into
 * mirror store state.
 *
 * The mirror never restores the owner's way (useTabRestoration creates
 * engine sessions, terminals, worktree checks — owner side effects). It
 * only needs the STATE: TabState rows with the owner's live tab ids, plus
 * a conversation-pane shell per tab (empty messages + persisted
 * messageCount, so lazy history hydration works exactly like the owner's
 * skeleton tabs).
 */
import type { ConversationPane, PersistedTabState, TabState } from '../../../shared/types'
import { makeLocalTab } from '../../stores/session-store-helpers'
import { makeMainPane } from '../../stores/conversation-instance'

export interface HydratedTabs {
  tabs: TabState[]
  activeTabId: string | null
}

/** Read the persisted `main` instance from a persisted conversation pane. */
function readMainInstance(st: PersistedTabState['tabs'][number]):
  | { messageCount?: number; modelOverride?: string | null; permissionMode?: 'auto' | 'plan'; permissionDenied?: unknown; planFilePath?: string | null }
  | null {
  const pane = (st as { conversationPane?: { instances?: Array<{ id?: string } & Record<string, unknown>> } }).conversationPane
  const inst = pane?.instances?.find((i) => i.id === 'main') ?? pane?.instances?.[0]
  return (inst as never) ?? null
}

/**
 * Patch the owner-authoritative metadata from the persisted main instance
 * onto a kept mirror pane's main instance, preserving identity when nothing
 * changed (no spurious re-renders on every sync).
 */
function refreshOwnerMetadata(
  pane: ConversationPane,
  main: NonNullable<ReturnType<typeof readMainInstance>>,
): ConversationPane {
  const idx = pane.instances.findIndex((i) => i.id === 'main')
  if (idx === -1) return pane
  const inst = pane.instances[idx]
  const permissionMode = main.permissionMode ?? 'auto'
  const planFilePath = main.planFilePath ?? null
  const modelOverride = main.modelOverride ?? null
  const permissionDenied = (main.permissionDenied as ConversationPane['instances'][number]['permissionDenied']) ?? null
  if (
    inst.permissionMode === permissionMode &&
    inst.planFilePath === planFilePath &&
    inst.modelOverride === modelOverride &&
    // Identity check is enough for the null↔set transitions that matter
    // (card shown/cleared); equal-but-recreated objects only cost a render.
    inst.permissionDenied === permissionDenied
  ) {
    return pane
  }
  const instances = pane.instances.slice()
  instances[idx] = { ...inst, permissionMode, planFilePath, modelOverride, permissionDenied }
  return { ...pane, instances }
}

/** Map the snapshot into mirror TabState rows (pure; no side effects). */
export function tabsFromSnapshot(
  snapshot: PersistedTabState,
  /** Owner-published live statuses (runtime, not persisted); mirror's
   *  current tabs as the fallback so a sync never resets a live status. */
  liveTabStatus?: Record<string, string>,
  existingTabs?: readonly TabState[],
): HydratedTabs {
  const existingById = new Map((existingTabs ?? []).map((t) => [t.id, t]))
  const tabs: TabState[] = []
  for (const st of snapshot.tabs) {
    if (!st.id) continue // owner ids are the join key; a row without one is unusable
    const status = (liveTabStatus?.[st.id] ?? existingById.get(st.id)?.status ?? 'idle') as TabState['status']
    tabs.push({
      ...makeLocalTab(),
      status,
      id: st.id,
      conversationId: st.conversationId ?? null,
      lastKnownSessionId: st.lastKnownSessionId || st.conversationId || null,
      historicalSessionIds: st.historicalSessionIds || [],
      title: st.title || 'Conversation',
      customTitle: st.customTitle || null,
      workingDirectory: st.workingDirectory,
      hasChosenDirectory: st.hasChosenDirectory,
      additionalDirs: st.additionalDirs ?? [],
      bashResults: st.bashResults || [],
      pillColor: st.pillColor || null,
      pillIcon: st.pillIcon || null,
      forkedFromSessionId: st.forkedFromSessionId || null,
      worktree: st.worktree ?? null,
      groupId: st.groupId || null,
      groupPinned: st.groupPinned ?? false,
      contextTokens: st.contextTokens || null,
      contextWindow: st.contextWindow || null,
      queuedPrompts: st.queuedPrompts ?? [],
      lastMessagePreview: st.lastMessagePreview || null,
      lastEventAt: st.lastEventAt ?? null,
      isTerminalOnly: st.isTerminalOnly ?? false,
      ...(st.engineProfileId ? { engineProfileId: st.engineProfileId } : {}),
    } as TabState)
  }
  const idx = snapshot.activeTabIndex
  const activeTabId = idx != null && idx >= 0 && idx < tabs.length ? tabs[idx].id : (tabs[0]?.id ?? null)
  return { tabs, activeTabId }
}

/**
 * Merge pane shells for the hydrated tabs into the existing pane map:
 * existing panes are KEPT (they may hold lazily-loaded messages or live
 * streamed state); missing ones get a skeleton with the persisted
 * messageCount; panes for tabs the owner closed are dropped.
 *
 * Kept panes still take the OWNER-AUTHORITATIVE per-conversation metadata
 * from the snapshot (permissionMode, planFilePath, modelOverride,
 * permissionDenied): the mirror never writes those fields itself (their
 * actions are forwarded) and not all of them ride normalized events — the
 * implement flow's plan→auto flip, for example, is owner-store-only, so
 * without this refresh the ATV status bar showed Plan forever. Messages,
 * queues, and drafts stay untouched (live-stream / window-local state).
 * The owner republishes within ~100ms of any pane change, so a stale
 * in-flight snapshot self-corrects on the next push.
 */
export function mergePanes(
  existing: Map<string, ConversationPane>,
  snapshot: PersistedTabState,
  tabs: TabState[],
): Map<string, ConversationPane> {
  const next = new Map<string, ConversationPane>()
  const byId = new Map(snapshot.tabs.map((st) => [st.id, st]))
  for (const tab of tabs) {
    const kept = existing.get(tab.id)
    if (kept) {
      const main = readMainInstance(byId.get(tab.id) ?? ({} as never))
      next.set(tab.id, main ? refreshOwnerMetadata(kept, main) : kept)
      continue
    }
    const main = readMainInstance(byId.get(tab.id) ?? ({} as never))
    next.set(
      tab.id,
      makeMainPane({
        messages: [],
        // Skeleton shell: history not yet loaded. Live events may append to
        // it before the user opens the tab — the explicit marker (not message
        // emptiness) is what keeps the dock's lazy hydration correct then.
        historyHydrated: false,
        messageCount: main?.messageCount ?? 0,
        modelOverride: main?.modelOverride || null,
        permissionMode: main?.permissionMode ?? 'auto',
        permissionDenied: (main?.permissionDenied as never) ?? null,
        planFilePath: main?.planFilePath ?? null,
      }),
    )
  }
  return next
}
