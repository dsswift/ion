/**
 * boot-restore-tab — restores ONE persisted tab into the store, dispatching
 * on tab kind (normal session, extension-hosted, terminal-only, sessionless).
 *
 * Split out of boot-restore-tabs.ts (which owns the loop and the
 * post-restore steps) to stay under the file-size cap. This is a faithful
 * server-side port of the deleted desktop/src/renderer/hooks/
 * useTabRestoration.ts (removed when the Overlay renderer that hosted it
 * was deleted in spec 17) — the ONLY changes from that file are the
 * environment seam: no React/useEffect (called directly from a plain async
 * boot function), no `host.shell.*` IPC bridge (the store and its actions
 * are called in-process, since this runs where the store actually lives
 * now), and the server's own logger instead of the renderer's.
 */
import { restoredConversationPreferences } from '../conversation-preferences'
import type { PersistedTab, TabState } from '@ion/shared/types'
import type { WorktreeInfo } from '@ion/shared/types-session'
import { persistedTabHasExtensions, isPersistedSettled } from '@ion/shared/tab-predicates'
import { useSessionStore } from '../store/sessionStore'
import { adoptTab } from '../store/host-api-engine'
import { makeLocalTab } from '../store/session-store-helpers'
import { makeMainPane, commitInstance } from '../store/conversation-instance'
import { resolveRegisteredWorktree } from '../store/worktree-registration'
import { restoreConversationTab } from './useTabRestoration-engine'
import {
  readMainInstance,
  restoredModelSelection,
  seedContextStatusFields,
  reassertRestoredPlanMode,
  resolvedInputLock,
} from './useTabRestoration-helpers'
import type { RestoredTabId } from './boot-restore-types'
import { restoredInboxTabFields } from './tab-inbox-restore'
import { debug as _debug, warn as _warn } from '../logger'
import { existsSync } from 'fs'

const TAG = 'boot-restore'
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

/** Does the worktree directory this tab persisted still exist on disk? */
async function worktreeStillExists(worktreePath: string): Promise<boolean> {
  try {
    const { access } = await import('fs/promises')
    await access(worktreePath)
    return true
  } catch {
    return false
  }
}

/**
 * Restore one persisted tab (by index in the saved manifest) into the
 * store, appending its resolved id(s) to `restoredTabIds`. Mutates
 * `worktreeAliveByIndex` with the "is this worktree directory still on
 * disk" probe result so the eager session-start pass below resolves the
 * SAME directory this restore did.
 */
export async function restoreOneTab(
  savedTabs: PersistedTab[],
  index: number,
  activeTabIndex: number | null | undefined,
  activeSessionId: string | null | undefined,
  restoredTabIds: RestoredTabId[],
  worktreeAliveByIndex: Map<number, boolean>,
): Promise<void> {
  let st = savedTabs[index]
  // Re-read the registry even when persisted metadata exists: landedAt is
  // terminal state written after the tab was persisted, and a restart must
  // seal that prior conversation before it can start another run. A
  // missing/unreadable registry falls back to persisted identity so a
  // transient read failure cannot orphan a review transcript.
  const registryWorktree = await resolveRegisteredWorktree(st.workingDirectory)
  const registeredWorktree = registryWorktree ?? st.worktree ?? null
  if (registeredWorktree && (!st.worktree || registeredWorktree.landedAt !== st.worktree.landedAt)) {
    st = { ...st, worktree: registeredWorktree }
    savedTabs[index] = st
  }

  // Every restored tab passes here, whichever branch takes it. A tab whose
  // directory is gone is not a crash — it is a conversation the Inbox files
  // under a path nobody can open, which reads as "it vanished". Say so, with
  // the path, so the log answers the question instead of an investigation
  // having to. A transfer that carried a path from another machine was how
  // this last happened.
  if (st.workingDirectory && !existsSync(st.workingDirectory)) {
    warn('restored with a working directory that does not exist', {
      tab_id: (st.id ?? '').slice(0, 8),
      working_directory: st.workingDirectory,
      has_worktree: !!st.worktree,
      is_terminal_only: !!st.isTerminalOnly,
    })
  }

  if (st.conversationId && !persistedTabHasExtensions(st)) {
    await restoreNormalTab(st, index, activeTabIndex, activeSessionId, restoredTabIds, worktreeAliveByIndex)
  } else if (persistedTabHasExtensions(st)) {
    await restoreConversationTab(st, restoredTabIds, index)
  } else if (st.isTerminalOnly) {
    await restoreTerminalOnlyTab(st, index, restoredTabIds)
  } else {
    await restoreSessionlessTab(st, index, restoredTabIds)
  }
}

/** A tab with a real engine conversation: active tabs load eagerly, others get a lazy skeleton. */
async function restoreNormalTab(
  st: PersistedTab,
  index: number,
  activeTabIndex: number | null | undefined,
  activeSessionId: string | null | undefined,
  restoredTabIds: RestoredTabId[],
  worktreeAliveByIndex: Map<number, boolean>,
): Promise<void> {
  const isActiveTab = (activeTabIndex !== undefined && activeTabIndex !== null && index === activeTabIndex) ||
    (!!(activeSessionId && st.conversationId === activeSessionId))

  // Restore worktree info if present (verify path still exists).
  let restoredWorktree = st.worktree || null
  if (restoredWorktree) {
    const alive = await worktreeStillExists(restoredWorktree.worktreePath)
    if (!alive) restoredWorktree = null
  }
  // Record the probe result so the eager session start below resolves the
  // SAME directory the tab state gets. Reading the raw persisted
  // `workingDirectory` there is what put worktree conversations back in the
  // base repo on every restart.
  worktreeAliveByIndex.set(index, restoredWorktree !== null)
  if (restoredWorktree?.landedAt) {
    // The tab is not in the store until resume/skeleton creation below;
    // lock metadata is applied in those branches, and this marks the
    // eager-start pass to skip the review-only session.
    worktreeAliveByIndex.set(index, false)
  }
  // Settled tabs are cold history records: no engine session, no
  // resumeSession. They always go through the skeleton path so the user
  // sees persisted history without bootstrapping anything.
  const settled = isPersistedSettled(st)
  if (settled) worktreeAliveByIndex.set(index, false)

  if (isActiveTab && !settled) {
    await restoreActiveNormalTab(st, index, restoredTabIds, restoredWorktree)
  } else {
    await restoreSkeletonNormalTab(st, index, restoredTabIds, restoredWorktree, settled)
  }
}

async function restoreActiveNormalTab(
  st: PersistedTab,
  index: number,
  restoredTabIds: RestoredTabId[],
  restoredWorktree: WorktreeInfo | null,
): Promise<void> {
  // Active tab: load messages eagerly via resumeSession.
  const tabId = await useSessionStore.getState().resumeSession(
    st.conversationId!,
    st.title,
    st.workingDirectory,
    undefined,
    undefined,
    // Adopt the persisted id rather than minting one.
    st.id || undefined,
  )
  restoredTabIds.push({ tabId, sessionId: st.conversationId ?? null, index })
  // Patch extra per-tab settings that resumeSession doesn't handle.
  // modelOverride / draftInput / permissionDenied / planFilePath /
  // permissionMode moved off TabState onto the active `main`
  // ConversationInstance, so they are layered onto the existing pane
  // (seeded eagerly at tab creation / by resumeSession) via commitInstance
  // in the same set, rather than written to the tab object.
  useSessionStore.setState((s) => {
    const main = readMainInstance(st)
    // permissionMode: prefer instance-persisted value; fall back to legacy
    // tab-level field for tabs saved before WI-002.
    const restoredMode: 'auto' | 'plan' = main?.permissionMode ?? (st as unknown as { permissionMode?: 'auto' | 'plan' }).permissionMode ?? 'auto'
    const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => ({
      ...inst,
      ...restoredModelSelection(main),
      draftInput: main?.draftInput ?? '',
      permissionMode: restoredMode,
      // Absent means 'off' — the serializer omits the default.
      thinkingEffort: main?.thinkingEffort ?? 'off',
      // Persisted permissionDenied is authoritative over resumeSession reconstruction.
      ...(main?.permissionDenied ? { permissionDenied: main.permissionDenied } : {}),
      ...(main?.planFilePath ? { planFilePath: main.planFilePath } : {}),
      ...seedContextStatusFields(inst, main),
    }))
    return {
      conversationPanes,
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              ...(st.principalSubject ? { principalSubject: st.principalSubject } : {}),
              conversationPreferences: restoredConversationPreferences(st),
              customTitle: st.customTitle || null,
              hasChosenDirectory: st.hasChosenDirectory,
              additionalDirs: st.additionalDirs,
              bashResults: st.bashResults || [],
              pillColor: st.pillColor || null,
              inputLocked: st.inputLocked ?? false,
              tabRole: st.tabRole ?? null,
              worktree: restoredWorktree,
              historicalSessionIds: st.historicalSessionIds || [],
              lastKnownSessionId: st.lastKnownSessionId || null,
              contextTokens: main?.contextTokens ?? st.contextTokens ?? null,
              contextWindow: main?.contextWindow ?? st.contextWindow ?? null,
              queuedPrompts: st.queuedPrompts?.length ? [st.queuedPrompts.join('\n\n')] : [],
              attachments: st.attachments ?? [],
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
              lastResult: st.lastResult ?? null,
              // If worktree is valid, restore workingDirectory to worktree path.
              // If worktree was cleaned up, fall back to original repo path.
              ...(restoredWorktree
                ? { workingDirectory: restoredWorktree.worktreePath }
                : st.worktree ? { workingDirectory: st.worktree.repoPath } : {}),
            }
          : t
      ),
    }
  })
  reassertRestoredPlanMode(tabId, readMainInstance(st), (st as unknown as { permissionMode?: 'auto' | 'plan' }).permissionMode)
  if (st.draftInput) debug('draft for tab', { tab_id: tabId.slice(0, 8), count: st.draftInput.length })
}

async function restoreSkeletonNormalTab(
  st: PersistedTab,
  index: number,
  restoredTabIds: RestoredTabId[],
  restoredWorktree: WorktreeInfo | null,
  settled: boolean,
): Promise<void> {
  // Non-active tab: create a skeleton tab whose `main` instance has empty
  // messages + a persisted messageCount (lazy load). Adopt the persisted
  // id — a restored tab is the SAME tab, and its id is the key for
  // per-conversation state that lives elsewhere. A record saved before ids
  // were persisted has none; it gets a fresh one, which is correct — there
  // is no prior identity to preserve.
  const persistedId = st.id || crypto.randomUUID()
  let tabId: string
  try {
    tabId = adoptTab(persistedId).tabId
  } catch {
    tabId = persistedId
  }
  restoredTabIds.push({ tabId, sessionId: st.conversationId ?? null, index })
  // Read the persisted `main` instance up front: the tab literal below
  // seeds its context scalars from it, and the skeleton pane built
  // afterwards reuses the same read.
  const main = readMainInstance(st)
  const tab: TabState = {
    ...makeLocalTab(),
    id: tabId,
    // A restore has no Studio-wire connection at all (this runs at process
    // boot), so `makeLocalTab()`'s ambient stamp is always undefined here --
    // the persisted owner is the only source of truth for a restored tab.
    ...(st.principalSubject ? { principalSubject: st.principalSubject } : {}),
    conversationPreferences: restoredConversationPreferences(st),
    conversationId: st.conversationId,
    lastKnownSessionId: st.lastKnownSessionId || st.conversationId,
    historicalSessionIds: st.historicalSessionIds || [],
    title: st.title || 'Resumed Session',
    customTitle: st.customTitle || null,
    workingDirectory: st.workingDirectory,
    hasChosenDirectory: st.hasChosenDirectory,
    additionalDirs: st.additionalDirs,
    bashResults: st.bashResults || [],
    pillColor: st.pillColor || null,
    ...resolvedInputLock(st, restoredWorktree),
    tabRole: st.tabRole ?? null,
    forkedFromSessionId: st.forkedFromSessionId || null,
    worktree: restoredWorktree,
    contextTokens: main?.contextTokens ?? st.contextTokens ?? null,
    contextWindow: main?.contextWindow ?? st.contextWindow ?? null,
    queuedPrompts: st.queuedPrompts?.length ? [st.queuedPrompts.join('\n\n')] : [],
    attachments: st.attachments ?? [],
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
    lastResult: st.lastResult ?? null,
    ...(restoredWorktree
      ? { workingDirectory: restoredWorktree.worktreePath }
      : st.worktree ? { workingDirectory: st.worktree.repoPath } : {}),
  }

  // Skeleton (lazy-load) tab: seed the `main` instance with empty messages
  // but the persisted messageCount so blank-tab detection and lazy-load
  // gating still work.
  const skeletonMode: 'auto' | 'plan' = main?.permissionMode ?? (st as unknown as { permissionMode?: 'auto' | 'plan' }).permissionMode ?? 'auto'
  const pane = makeMainPane({
    messages: [],
    historyHydrated: false,
    messageCount: main?.messageCount ?? 0,
    ...restoredModelSelection(main),
    draftInput: main?.draftInput ?? '',
    permissionDenied: main?.permissionDenied ?? null,
    planFilePath: main?.planFilePath ?? null,
    permissionMode: skeletonMode,
    thinkingEffort: main?.thinkingEffort ?? 'off',
    ...seedContextStatusFields({}, main),
  })

  useSessionStore.setState((s) => {
    const conversationPanes = new Map(s.conversationPanes)
    conversationPanes.set(tabId, pane)
    return { tabs: [...s.tabs, tab], conversationPanes }
  })
  // Settled tabs have no engine session; skip the permission-mode call that
  // would target a nonexistent session.
  if (!settled) reassertRestoredPlanMode(tabId, main, (st as unknown as { permissionMode?: 'auto' | 'plan' }).permissionMode)
  if (main?.draftInput) debug('skeleton tab draft', { tab_id: tabId.slice(0, 8), count: main.draftInput.length })
}

async function restoreTerminalOnlyTab(st: PersistedTab, index: number, restoredTabIds: RestoredTabId[]): Promise<void> {
  const tabId = await useSessionStore.getState().createTerminalTab(undefined, st.id || undefined)
  restoredTabIds.push({ tabId, sessionId: null, index })

  useSessionStore.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === tabId
        ? {
            ...t,
            ...(st.principalSubject ? { principalSubject: st.principalSubject } : {}),
            conversationPreferences: restoredConversationPreferences(st),
            customTitle: st.customTitle || null,
            workingDirectory: st.workingDirectory,
            hasChosenDirectory: st.hasChosenDirectory,
            pillColor: st.pillColor || null,
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
          }
        : t
    ),
  }))
  if (st.draftInput) debug('draft for terminal tab', { tab_id: tabId.slice(0, 8), count: st.draftInput.length })

  // Restore terminal instances from persisted state. Scrollback buffers are
  // NOT restored here — that requires a mounted xterm.js widget, which only
  // exists in an attaching CLIENT (see setSavedBuffer's doc in
  // host-api-misc.ts); a client re-populates its own scrollback from the
  // terminal-attach protocol's snapshot when it attaches.
  if (st.terminalInstances && st.terminalInstances.length > 0) {
    const panes = new Map(useSessionStore.getState().terminalPanes)
    panes.set(tabId, {
      instances: st.terminalInstances,
      activeInstanceId: st.terminalInstances[0].id,
    })
    useSessionStore.setState({ terminalPanes: panes })
  }
}

async function restoreSessionlessTab(st: PersistedTab, index: number, restoredTabIds: RestoredTabId[]): Promise<void> {
  // Sessionless tab (e.g. has editor state but no messages sent yet). The
  // directory is the one this conversation was persisted with, so it is a
  // restore: a folder that has since been removed must not cost the operator
  // the tab, which is what the new-conversation existence check would do.
  const tabId = await useSessionStore.getState().createTabInDirectory(st.workingDirectory, false, true, undefined, true)
  restoredTabIds.push({ tabId, sessionId: null, index })

  const sessionlessMain = readMainInstance(st)
  const sessionlessMode: 'auto' | 'plan' = sessionlessMain?.permissionMode ?? (st as unknown as { permissionMode?: 'auto' | 'plan' }).permissionMode ?? 'auto'
  const sessionlessPane = makeMainPane({
    ...restoredModelSelection(sessionlessMain),
    draftInput: sessionlessMain?.draftInput ?? '',
    permissionMode: sessionlessMode,
    thinkingEffort: sessionlessMain?.thinkingEffort ?? 'off',
  })

  useSessionStore.setState((s) => {
    const conversationPanes = new Map(s.conversationPanes)
    conversationPanes.set(tabId, sessionlessPane)
    return {
      conversationPanes,
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              ...(st.principalSubject ? { principalSubject: st.principalSubject } : {}),
              conversationPreferences: restoredConversationPreferences(st),
              customTitle: st.customTitle || null,
              hasChosenDirectory: st.hasChosenDirectory,
              additionalDirs: st.additionalDirs,
              pillColor: st.pillColor || null,
              ...resolvedInputLock(st, st.worktree),
              tabRole: st.tabRole ?? null,
              forkedFromSessionId: st.forkedFromSessionId || null,
              worktree: st.worktree || null,
              historicalSessionIds: st.historicalSessionIds || [],
              lastKnownSessionId: st.lastKnownSessionId || null,
              contextTokens: st.contextTokens || null,
              contextWindow: st.contextWindow || null,
              queuedPrompts: st.queuedPrompts?.length ? [st.queuedPrompts.join('\n\n')] : [],
              attachments: st.attachments ?? [],
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
              lastResult: st.lastResult ?? null,
            }
          : t
      ),
    }
  })
  reassertRestoredPlanMode(tabId, sessionlessMain, (st as unknown as { permissionMode?: 'auto' | 'plan' }).permissionMode)
  if (sessionlessMain?.draftInput) debug('draft for sessionless tab', { tab_id: tabId.slice(0, 8), count: sessionlessMain.draftInput.length })
}
