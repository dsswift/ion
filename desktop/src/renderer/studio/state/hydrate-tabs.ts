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
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { FileAttachment, ConversationPane, PersistedTabState, TabState } from '@ion/shared/types'
import type { ThinkingEffort } from '@ion/shared/types-session'
import { restoredInboxTabFields } from '@ion/server/hooks/tab-inbox-restore'
import { makeLocalTab } from '@ion/server/store/session-store-helpers'
import { makeMainPane } from '@ion/server/store/conversation-instance'

export interface HydratedTabs {
  tabs: TabState[]
  /** Cold records remain outside the active tab list. */
  settledHistory: TabState[]
  activeTabId: string | null
}

import { seedContextStatusFields } from '@ion/server/hooks/useTabRestoration-helpers'

/** Read the persisted `main` instance from a persisted conversation pane. */
function readMainInstance(st: PersistedTabState['tabs'][number]):
  | { messageCount?: number; modelOverride?: string | null; permissionMode?: 'auto' | 'plan'; permissionDenied?: unknown; planFilePath?: string | null; contextTokens?: number; contextWindow?: number; thinkingEffort?: ThinkingEffort; draftInput?: string }
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
  // thinkingEffort is per-conversation state (see tab-slice-thinking.ts) that
  // has no wire event of its own — setThinkingEffort is a FORWARDED action so
  // the owner's mutation happens correctly, but nothing pushes the resulting
  // value back to the mirror except this snapshot refresh. Explicit 'off'
  // default (not a fallback to the CURRENT mirror value) so the mirror also
  // converges when the owner resets a conversation back to no thinking.
  const thinkingEffort: ThinkingEffort = main.thinkingEffort ?? 'off'
  // The unsent draft is owner state like the rest of this list: the owner
  // persists it and reads it back at boot, and this refresh is the only thing
  // that carries a draft typed on another client into an already-open mirror
  // pane. Last-write-wins, same as every field above — the composer's own
  // edits reach the owner through the forwarder and come back here.
  const draftInput = main.draftInput ?? ''
  if (
    inst.permissionMode === permissionMode &&
    inst.planFilePath === planFilePath &&
    inst.modelOverride === modelOverride &&
    // Identity check is enough for the null↔set transitions that matter
    // (card shown/cleared); equal-but-recreated objects only cost a render.
    inst.permissionDenied === permissionDenied &&
    inst.thinkingEffort === thinkingEffort &&
    inst.draftInput === draftInput
  ) {
    return pane
  }
  const instances = pane.instances.slice()
  instances[idx] = { ...inst, permissionMode, planFilePath, modelOverride, permissionDenied, thinkingEffort, draftInput }
  return { ...pane, instances }
}

/** Map the snapshot into mirror TabState rows (pure; no side effects). */
export function tabsFromSnapshot(
  snapshot: PersistedTabState,
  /** Owner-published live statuses (runtime, not persisted); mirror's
   *  current tabs as the fallback so a sync never resets a live status. */
  liveTabStatus?: Record<string, string>,
  existingTabs?: readonly TabState[],
  queuedAttachments?: Record<string, FileAttachment[]>,
  /** Owner-published live compaction flags — same live-not-persisted
   *  category as liveTabStatus. Without this, a re-sync during a
   *  compaction (triggered by anything else touching the tab, e.g. the
   *  lastEventAt stamp on every normalized event) resets isCompacting to
   *  its default false, flashing the live indicator off after ~1s even
   *  though the compaction is still running. */
  liveIsCompacting?: Record<string, boolean>,
  /** The Environment these rows belong to (ADR-033 union store); stamped on every row. */
  environmentId: string = LOCAL_ENVIRONMENT_ID,
): HydratedTabs {
  const existingById = new Map((existingTabs ?? []).map((t) => [t.id, t]))
  const tabs: TabState[] = []
  for (const st of snapshot.tabs) {
    if (!st.id) continue // owner ids are the join key; a row without one is unusable
    const status = (liveTabStatus?.[st.id] ?? existingById.get(st.id)?.status ?? 'idle') as TabState['status']
    const isCompacting = liveIsCompacting?.[st.id] ?? existingById.get(st.id)?.isCompacting ?? false
    tabs.push({
      ...makeLocalTab(),
      environmentId,
      status,
      isCompacting,
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
      forkedFromSessionId: st.forkedFromSessionId || null,
      worktree: st.worktree ?? null,
      contextTokens: readMainInstance(st)?.contextTokens ?? st.contextTokens ?? null,
      contextWindow: readMainInstance(st)?.contextWindow ?? st.contextWindow ?? null,
      queuedPrompts: st.queuedPrompts ?? [],
      // Attachments are intentionally transient and never persist to disk, but
      // the owner projects them into its Studio sync snapshot so queued-preview
      // cards render in the mirror before a prompt is submitted.
      attachments: queuedAttachments?.[st.id] ?? [],
      lastMessagePreview: st.lastMessagePreview || null,
      lastEventAt: st.lastEventAt ?? null,
      ...restoredInboxTabFields(st),
      lastActivityAt: st.lastActivityAt ?? null,
                          lastMessageAt: st.lastMessageAt ?? null,
      idleSince: st.idleSince ?? null,
      lastCompletionAt: st.lastCompletionAt ?? null,
      settledOverride: st.settledOverride ?? null,
      settledAt: st.settledAt ?? null,
      snoozedUntil: st.snoozedUntil ?? null,
      snoozedAt: st.snoozedAt ?? null,
      lastVisitedAt: st.lastVisitedAt ?? null,
      manualUnread: st.manualUnread ?? false,
      isTerminalOnly: st.isTerminalOnly ?? false,
      // Lock + role ride the owner snapshot so the mirror renders the same
      // affordances: a locked auto-fix tab must not offer a prompt input in
      // the Studio window, and role-aware surfaces (bench singleton) must agree.
      inputLocked: st.inputLocked ?? false,
      inputLockReason: st.inputLockReason ?? null,
      tabRole: st.tabRole ?? null,
      ...(st.engineProfileId ? { engineProfileId: st.engineProfileId } : {}),
    } as TabState)
  }
  const settledHistory = (snapshot.settledHistory ?? [])
    .filter((st) => !!st.id)
    .map((st) => ({
      ...makeLocalTab(),
      environmentId,
      id: st.id!,
      conversationId: st.conversationId ?? null,
      lastKnownSessionId: st.lastKnownSessionId || st.conversationId || null,
      historicalSessionIds: st.historicalSessionIds || [],
      title: st.title || 'Conversation',
      customTitle: st.customTitle || null,
      workingDirectory: st.workingDirectory,
      hasChosenDirectory: st.hasChosenDirectory,
      additionalDirs: st.additionalDirs ?? [],
      worktree: st.worktree ?? null,
      lastMessagePreview: st.lastMessagePreview || null,
      lastMessageAt: st.lastMessageAt ?? null,
      settledOverride: st.settledOverride === 'auto' ? 'auto' as const : 'settled' as const,
      settledAt: st.settledAt ?? null,
      inputLocked: true,
      inputLockReason: 'settled' as const,
      ...(st.engineProfileId ? { engineProfileId: st.engineProfileId } : {}),
    } as TabState))
  const idx = snapshot.activeTabIndex
  const activeTabId = idx != null && idx >= 0 && idx < tabs.length ? tabs[idx].id : (tabs[0]?.id ?? null)
  return { tabs, settledHistory, activeTabId }
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
 * without this refresh the Studio window status bar showed Plan forever. Messages,
 * queues, and drafts stay untouched (live-stream / window-local state).
 * The owner republishes within ~100ms of any pane change, so a stale
 * in-flight snapshot self-corrects on the next push.
 */
export function mergePanes(
  existing: Map<string, ConversationPane>,
  snapshot: PersistedTabState,
  tabs: TabState[],
  /** Server-decided model per tab and instance (see `applyResolvedModels`). Absent leaves each instance's value as it was. */
  resolvedModels?: ResolvedModelMap,
): Map<string, ConversationPane> {
  const next = new Map<string, ConversationPane>()
  const byId = new Map(snapshot.tabs.map((st) => [st.id, st]))
  for (const tab of tabs) {
    const kept = existing.get(tab.id)
    if (kept) {
      const main = readMainInstance(byId.get(tab.id) ?? ({} as never))
      next.set(tab.id, applyResolvedModels(main ? refreshOwnerMetadata(kept, main) : kept, resolvedModels?.[tab.id]))
      continue
    }
    const main = readMainInstance(byId.get(tab.id) ?? ({} as never))
    next.set(
      tab.id,
      applyResolvedModels(makeMainPane({
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
        // Seed the owner's persisted per-conversation thinking-effort setting
        // (see tab-slice-thinking.ts) so a new mirror pane's status bar shows
        // the correct picker state on first paint instead of always 'off'.
        thinkingEffort: main?.thinkingEffort ?? 'off',
        // The unsent prompt the owner restored from tabs.json. Without this
        // seed the mirror builds every pane with an empty draft, so a draft
        // that survived the restart on disk still reached the composer as ''.
        draftInput: main?.draftInput ?? '',
        // Context occupancy so the Studio window's status bar (the SAME component as
        // the overlay's) is correct on first paint.
        ...seedContextStatusFields({}, main as never),
      }), resolvedModels?.[tab.id]),
    )
  }
  return next
}

/** Tab id → instance id → the model that instance runs on, as the server decided it. */
export type ResolvedModelMap = Record<string, Record<string, string>>

/**
 * Stamp the server-decided model onto each instance of a pane, preserving
 * identity when nothing changed. An instance the map does not name keeps the
 * value it had: a sync that carries no map (an older server) must not erase
 * what an earlier one said.
 */
export function applyResolvedModels(pane: ConversationPane, byInstance: Record<string, string> | undefined): ConversationPane {
  if (!byInstance) return pane
  let changed = false
  const instances = pane.instances.map((inst) => {
    const resolved = byInstance[inst.id]
    if (resolved === undefined || inst.resolvedModel === resolved) return inst
    changed = true
    return { ...inst, resolvedModel: resolved }
  })
  return changed ? { ...pane, instances } : pane
}

/**
 * Which tab the window shows after an environment's tab list arrives.
 *
 * The window holds tabs from several environments and its active tab is
 * its own. A remote server's active tab never moves it: another device's
 * activity there must not steal focus, so it only fills in when the window
 * has no selection left. The local server is the one that selects on this
 * window's behalf (it opens the tab it just created), so the window
 * follows it -- but only when the local server's choice CHANGED. Its
 * steady state used to win on every local sync, which yanked the window
 * off a remote conversation back to whatever local tab was last active
 * the moment anything local re-published.
 */
export function nextActiveTabId(args: {
  environmentId: string
  ownerActiveTabId: string | null
  ownerChanged: boolean
  currentTabId: string | null
  currentEnvironmentId: string | null
  firstTabId: string | null
}): string | null {
  const { environmentId, ownerActiveTabId, ownerChanged, currentTabId, currentEnvironmentId, firstTabId } = args
  if (currentTabId === null) return ownerActiveTabId ?? firstTabId
  if (environmentId !== LOCAL_ENVIRONMENT_ID) return currentTabId
  // Local sync. While the window is on a local tab the local owner stays
  // authoritative; on a remote tab only a fresh local selection moves it.
  if (currentEnvironmentId === LOCAL_ENVIRONMENT_ID) return ownerActiveTabId ?? currentTabId
  return ownerChanged && ownerActiveTabId ? ownerActiveTabId : currentTabId
}
