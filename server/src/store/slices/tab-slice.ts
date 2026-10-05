import type { TabState } from '@ion/shared/types'
import { usePreferencesStore } from '../../persistence/preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, isReusableBlankConversationTab, initialModelOverride, initialPermissionMode, initialThinkingEffort } from '../session-store-helpers'
import { makeMainPane, commitInstance, activeInstance, instanceMessageCount, isEmptyConversation, needsHistoryHydration } from '../conversation-instance'
import { cleanupTabDeltas } from './engine-event-slice'
import { applySetThinkingEffort } from './tab-slice-thinking'
import { applyPermissionModeForTab } from './tab-slice-permission-mode'
import { registerTabOwner } from '../../protocol/tabs-index'
import { createConversationTabAction } from './engine-slice-create'
import { evaluateSessionBusyGuard, formatSessionBusyRefusal } from './session-busy-guard'
import { forgetTabContentTracking } from '../tab-content-tracking'
import { pickNextActiveTab } from './tab-slice-next-active'
import { resolveWorktreeForNewTab } from './tab-slice-worktree-resolve'
import { releaseEphemeralWorktreeOnClose } from './ephemeral-worktree-close'
import { rInfo, rDebug, rWarn } from '../rendererLogger'
import { isPersistedSettled } from '@ion/shared/tab-predicates'
import { setWorktreeUncommittedAction, addSystemMessageAction } from './tab-slice-misc-actions'
import { closeTab, createTab, deleteTabContent, saveSessionLabel, setPermissionMode, start, tabMetaChanged, terminalDestroy } from '../host-api'

export function createTabSlice(set: StoreSet, get: StoreGet): Partial<State> {
  // Unified creation entry point (Phase 2, #256). Both plain and engine tabs
  // go through this path. createTabInDirectory delegates here for base
  // creation and then applies its extra options (worktree, duplicate
  // check, recent-dir tracking) on top.
  const createConversationTab = createConversationTabAction(set, get)

  return {
    initStaticInfo: async () => {
      try {
        const result = await start()
        set({
          staticInfo: {
            version: result.version || 'unknown',
            email: result.auth?.email || null,
            subscriptionType: result.auth?.subscriptionType || null,
            projectPath: result.projectPath || '~',
            homePath: result.homePath || '~',
          },
        })
      } catch (err) {
        rDebug('tabs', 'initStaticInfo failed', { error: String(err) })
      }
    },

    setPermissionMode: (mode, source) => {
      // Active-tab UI entry point; the per-tab core lives in
      // tab-slice-permission-mode.ts so pipelines with an explicit tabId
      // (implement-slice) share the exact same flip.
      applyPermissionModeForTab(set, get, get().activeTabId, mode, source)
    },

    togglePermissionMode: (source) => {
      const tabId = get().activeTabId
      const pane = get().conversationPanes.get(tabId)
      const instance = pane?.instances.find((candidate) => candidate.id === pane.activeInstanceId)
      const mode = instance?.permissionMode === 'plan' ? 'auto' : 'plan'
      applyPermissionModeForTab(set, get, tabId, mode, source)
    },

    setThinkingEffort: (effort) => {
      // Delegated to tab-slice-thinking.ts (file-cap split). Per-conversation,
      // isolated per-tab/per-instance, applied live on the next prompt.
      applySetThinkingEffort(set, get, effort)
    },

    createTab: async (useWorktree) => {
      const homeDir = get().staticInfo?.homePath || '~'
      const defaultBase = usePreferencesStore.getState().defaultBaseDirectory
      const startDir = defaultBase || homeDir
      const hasChosen = !!defaultBase

      const existingBlank = get().tabs.find(
        (t) => isReusableBlankConversationTab(t, startDir, instanceMessageCount(activeInstance(get().conversationPanes, t.id)))
      )
      if (existingBlank) {
        set({
          activeTabId: existingBlank.id,
          tallViewTabId: null,
          terminalTallTabId: null,
        })
        return existingBlank.id
      }

      let tabId: string
      try {
        const res = await createTab()
        tabId = res.tabId
      } catch {
        tabId = crypto.randomUUID()
      }

      // Same shared resolver createTabInDirectory uses. This path already
      // resolved before its set() and pre-starts no session, so it converged
      // correctly on its own — routing it through the resolver means there is
      // ONE implementation of "where does a worktree conversation live" rather
      // than two that happen to agree.
      const resolved = await resolveWorktreeForNewTab(startDir, useWorktree, undefined, { ownerTabId: tabId })

      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        workingDirectory: resolved.dir,
        hasChosenDirectory: hasChosen,
        worktree: resolved.worktree,
        pendingWorktreeSetup: resolved.pendingSetup,
      }
      if (tab.principalSubject) registerTabOwner(tab.id, tab.principalSubject)

      set((s) => ({
        tabs: [...s.tabs, tab],
        // Seed the single-instance `main` pane so message/draft/model state has
        // a home from creation (2A invariant). Carry the plan-model split
        // override onto the instance since modelOverride no longer lives on the tab.
        conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({ modelOverride: initialModelOverride(), modelOverrideSource: initialModelOverride() ? 'automatic' : null, permissionMode: initialPermissionMode(), thinkingEffort: initialThinkingEffort(initialModelOverride()) })),
        activeTabId: tab.id,
        tallViewTabId: null,
        terminalTallTabId: null,
      }))
      setPermissionMode(tabId, initialPermissionMode(), 'tab_create')
      return tabId
    },

    createTabInDirectory: async (dir, useWorktree, skipDuplicateCheck, sourceBranch, restoring) => {
      if (!skipDuplicateCheck) {
        const existingBlank = get().tabs.find((t) => isReusableBlankConversationTab(t, dir, instanceMessageCount(activeInstance(get().conversationPanes, t.id))))
        if (existingBlank) {
          set({
            activeTabId: existingBlank.id,
            tallViewTabId: null,
            terminalTallTabId: null,
          })
          return existingBlank.id
        }
      }

      // The unified creator resolves the requested worktree before it creates
      // state or starts the session. Keeping this entry point thin prevents
      // plain and profile-backed project shortcuts from drifting apart.
      const tabId = await createConversationTab(dir, {
        setActive: true,
        useWorktree,
        sourceBranch,
        ...(restoring ? { restoring: true } : {}),
      })

      return tabId
    },

    selectTab: (tabId) => {
      const s = get()
      if (tabId === s.activeTabId) {
        // A user can acknowledge a completed run by opening the row that is
        // already selected. No activeTabId change occurs in that case, so the
        // focus subscription cannot record this review for us.
        get().markTabRead(tabId)
        if (!s.isExpanded) {
          set({
            isExpanded: true,
            settingsOpen: false,
          })
        }
        return
      }
      set((prev) => {
        const reviewTab = prev.tabs.find((tab) => tab.id === prev.activeTabId && isPersistedSettled(tab))
        const returningReview = reviewTab != null && reviewTab.id !== tabId
        const tabs = returningReview ? prev.tabs.filter((tab) => tab.id !== reviewTab.id) : prev.tabs
        const settledHistory = returningReview
          ? [...prev.settledHistory.filter((tab) => tab.id !== reviewTab.id), reviewTab]
          : prev.settledHistory
        const conversationPanes = returningReview
          ? new Map([...prev.conversationPanes].filter(([id]) => id !== reviewTab.id))
          : prev.conversationPanes
        return {
          activeTabId: tabId,
          isExpanded: true,
          tallViewTabId: null,
          terminalTallTabId: null,
          settingsOpen: false,
          tabs,
          settledHistory,
          conversationPanes,
        }
      })
      // Focused-session publishing now lives in lib/active-tab-notifier.ts —
      // a store subscription on activeTabId that also covers the tab-create
      // paths, which set activeTabId without going through selectTab.

      // If skeleton tab (history not yet loaded), load it asynchronously.
      // needsHistoryHydration is the precise gate — it fires even when live
      // streamed messages have already landed on the unopened skeleton pane
      // (message emptiness is NOT a reliable hydration proxy).
      const targetTabAfter = get().tabs.find(t => t.id === tabId)
      if (targetTabAfter?.conversationId) {
        if (needsHistoryHydration(activeInstance(get().conversationPanes, tabId))) {
          get().loadSkeletonMessages(tabId).catch((err) => rWarn('tab.select', 'loadSkeletonMessages failed', { tab_id: tabId.slice(0, 8), error: String(err) }))
        }
      }
    },

    closeTab: (tabId, origin = 'local') => {
      const closingTab = get().tabs.find((t) => t.id === tabId)
      if (!closingTab) {
        rDebug('tab.close', 'close ignored: tab already absent', { tab_id: tabId, origin })
        return
      }
      // Action-layer guard: hard-block immediate removal while the orchestrator
      // or a dispatched background agent is still running.
      // evaluateSessionBusyGuard in session-busy-guard.ts for the full rationale
      // (plain conversations can dispatch sub-agents too, so this is not
      // engine-only).
      if (closingTab) {
        const pane = get().conversationPanes.get(tabId)
        const guard = evaluateSessionBusyGuard(pane)
        const terminalRunning = [...(get().terminalActivities ?? new Map()).values()].some((activity) => activity.tabId === tabId && activity.active)
        if (guard.blocked || terminalRunning) {
          const reason = terminalRunning && !guard.blocked
            ? `refused to close the tab: tabId=${tabId.slice(0, 8)} terminal activity is running`
            : formatSessionBusyRefusal(tabId, guard, 'close the tab')
          rWarn('tab.close', 'close blocked by guard', { tab_id: tabId, reason })
          return
        }
      }
      // Close is recoverable after a conversation contains a message: a durable
      // conversation enters Settled History. An untouched empty conversation has
      // no history to recover, so close permanently removes it. Delete remains
      // the explicit permanent verb for non-empty conversations. The guard above
      // deliberately runs first: confirmed close must never stop active work.
      const emptyConversation = !closingTab.isTerminalOnly
        && isEmptyConversation(closingTab, get().conversationPanes.get(tabId))
      const permanentDelete = origin === 'delete' || origin === 'remote-delete'
      const mainAlreadyClosed = origin === 'remote' || origin === 'remote-delete'
      if (!permanentDelete && !closingTab.isTerminalOnly && closingTab.conversationId && !emptyConversation) {
        rInfo('tab.close', 'non-empty conversation routed to settled history', { tab_id: tabId, origin })
        void get().settleTab(tabId).then(() => releaseEphemeralWorktreeOnClose(set, get, closingTab))
        return
      }
      if (!permanentDelete && !mainAlreadyClosed && emptyConversation) {
        rInfo('tab.close', 'empty conversation routed to permanent deletion', {
          tab_id: tabId,
          origin,
          has_conversation_id: closingTab.conversationId !== null,
        })
        void get().deleteConversationTab(tabId)
        return
      }
      // Closing a conversation NEVER removes an ordinary worktree. An ephemeral
      // one, cut for this conversation, goes through Retire's appraisal once the
      // tab is gone (ephemeral-worktree-close.ts).
      //
      // This used to call gitWorktreeRemove(..., force = true), and the remove
      // handler then ran `git branch -D`. A stray Cmd+W therefore destroyed
      // uncommitted changes and made unlanded commits unreachable, silently and
      // unrecoverably.
      //
      // A conversation and a worktree are separate lifetimes: a conversation is
      // a thread of discussion, a worktree is a place work lives. Removing a
      // worktree is its own explicit verb ("Retire"), gated by its own
      // appraisal (main/worktree/safety.ts). Because close is now cheap and
      // reversible it does not need to be forbidden — the worktree survives,
      // and the Worktrees list in the git panel offers a one-click path back
      // into it with a fresh conversation.
      if (closingTab?.worktree) {
        rInfo('tabs', 'closing worktree conversation', {
          tab_id: tabId,
          worktree_path: closingTab.worktree.worktreePath,
          branch: closingTab.worktree.branchName,
        })
        void releaseEphemeralWorktreeOnClose(set, get, closingTab)
      }
      if (!mainAlreadyClosed) {
        closeTab(tabId).catch((err) => rWarn('tabs', 'closeTab IPC failed', { tab_id: tabId, error: String(err) }))
      }
      // Delete externalized tab content after either origin. Main's remote-close
      // handler stops sessions but does not own this renderer persistence file.
      deleteTabContent?.(tabId)?.catch?.((err) => rDebug('tabs', 'deleteTabContent failed', { tab_id: tabId, error: String(err) }))
      forgetTabContentTracking(tabId)
      const pane = get().terminalPanes.get(tabId)
      if (pane) {
        for (const inst of pane.instances) {
          const key = `${tabId}:${inst.id}`
          if (!mainAlreadyClosed) {
            terminalDestroy(key).catch((err) => rWarn('tabs', 'terminalDestroy on close failed', { key, error: String(err) }))
          }
        }
      }
      const termIds = get().terminalOpenTabIds
      const panes = new Map(get().terminalPanes)
      panes.delete(tabId)
      const suspendedTallClear = get().suspendedTallTabId === tabId ? { suspendedTallTabId: null } : {}
      if (termIds.has(tabId)) {
        const next = new Set(termIds)
        next.delete(tabId)
        set({ terminalOpenTabIds: next, terminalPanes: panes, ...suspendedTallClear })
      } else {
        set({ terminalPanes: panes, ...suspendedTallClear })
      }
      // Tear down per-conversation state on close. TAB-TYPE-AGNOSTIC: every
      // conversation tab (plain or extension-hosted) is seeded a
      // conversationPane at creation (makeMainPane), so the pane MUST be
      // deleted for plain tabs too — gating this on tabHasExtensions leaked
      // the pane (its main instance's messages / statusFields / agentStates)
      // for every plain tab on close. The engine-* maps only ever hold keys
      // for extension tabs, but deleting absent keys is harmless (each loop is
      // prefix-guarded), so the whole block runs unconditionally.
      if (closingTab) {
        const engineWorkingMessages = new Map(get().engineWorkingMessages)
        const engineNotifications = new Map(get().engineNotifications)
        const engineDialogs = new Map(get().engineDialogs)
        const enginePinnedPrompt = new Map(get().enginePinnedPrompt)
        const conversationPanes = new Map(get().conversationPanes)
        for (const k of engineWorkingMessages.keys()) if (k === tabId || k.startsWith(`${tabId}:`)) engineWorkingMessages.delete(k)
        for (const k of engineNotifications.keys()) if (k === tabId || k.startsWith(`${tabId}:`)) engineNotifications.delete(k)
        for (const k of engineDialogs.keys()) if (k === tabId || k.startsWith(`${tabId}:`)) engineDialogs.delete(k)
        for (const k of enginePinnedPrompt.keys()) if (k === tabId || k.startsWith(`${tabId}:`)) enginePinnedPrompt.delete(k)
        conversationPanes.delete(tabId)
        set({ engineWorkingMessages, engineNotifications, engineDialogs, enginePinnedPrompt, conversationPanes })
        cleanupTabDeltas(tabId)
      }
      if (closingTab) {
        const dir = closingTab.workingDirectory
        const otherTabInDir = get().tabs.some((t) => t.id !== tabId && t.workingDirectory === dir)
        if (!otherTabInDir) {
          const updates: Record<string, any> = {}
          const explorerDirs = get().fileExplorerOpenDirs
          if (explorerDirs.has(dir)) {
            const next = new Set(explorerDirs)
            next.delete(dir)
            updates.fileExplorerOpenDirs = next
          }
          const editorDirs = get().fileEditorOpenDirs
          if (editorDirs.has(dir)) {
            const next = new Set(editorDirs)
            next.delete(dir)
            updates.fileEditorOpenDirs = next
          }
          if (Object.keys(updates).length > 0) set(updates)
        }
      }

      const s = get()
      const remaining = s.tabs.filter((t) => t.id !== tabId)

      if (s.activeTabId === tabId) {
        if (remaining.length === 0) {
          const homeDir = get().staticInfo?.homePath || '~'
          const defaultBase = usePreferencesStore.getState().defaultBaseDirectory
          const startDir = defaultBase || homeDir
          const newTab = makeLocalTab()
          newTab.workingDirectory = startDir
          newTab.hasChosenDirectory = !!defaultBase
          if (newTab.principalSubject) registerTabOwner(newTab.id, newTab.principalSubject)
          // Seed the single-instance `main` pane for the replacement tab so its
          // message/draft/model state has a home (2A invariant).
          set({
            tabs: [newTab],
            activeTabId: newTab.id,
            gitPanelOpen: false,
            conversationPanes: new Map(get().conversationPanes).set(newTab.id, makeMainPane({ modelOverride: initialModelOverride(), modelOverrideSource: initialModelOverride() ? 'automatic' : null, thinkingEffort: initialThinkingEffort(initialModelOverride()) })),
          })
          return
        }
        const next = pickNextActiveTab(tabId, s.tabs)
        if (!next) {
          rWarn('tab.close', 'next-active selection unexpectedly empty', { tab_id: tabId, remaining_tabs: remaining.length })
          set({ tabs: remaining, activeTabId: remaining[0].id })
          return
        }
        rInfo('tab.close', 'selected next active tab', {
          closing_tab_id: tabId,
          target_tab_id: next.tabId,
          tier: next.tier,
          target_last_visited_at: next.lastVisitedAt ?? 0,
          target_last_activity_at: next.lastActivityAt ?? 0,
        })
        // Commit removal first so selectTab resolves target in current state.
        // selectTab remains single activation funnel for history hydration,
        // unread clearing, tall-view selection, and focus publication.
        set({ tabs: remaining })
        get().selectTab(next.tabId)
      } else {
        set({ tabs: remaining })
      }
    },

    renameTab: (tabId, customTitle) => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, customTitle } : t
        ),
      }))
      const tab = get().tabs.find((t) => t.id === tabId)
      if (tab?.conversationId) {
        void saveSessionLabel(tab.conversationId, customTitle)
      }
      // Push a lightweight desktop_tab_meta delta so iOS sees the renamed tab
      // immediately without waiting for the 5 s snapshot poll tick.
      const display = customTitle ?? get().tabs.find((t) => t.id === tabId)?.title
      if (display !== undefined) {
        tabMetaChanged({ tabId, title: display })
      }
    },

    setTabModel: (tabId, model, providerId) => {
      // A picker or remote model-selection command expresses user intent. It
      // remains an explicit per-prompt override, including for slash commands.
      // providerId (when the caller has it) records exactly which provider
      // group the operator clicked, so resolvePromptModel can qualify the
      // wire model id and this explicit choice can never be silently
      // requalified onto a different provider by defaultProvider bias.
      set((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({
          ...inst,
          modelOverride: model,
          modelOverrideSource: 'user',
          modelOverrideProviderId: providerId ?? null,
        })),
      }))
    },

    setTabAutomaticModel: (tabId, model) => {
      // Plan/implementation/workflow selection chooses the ambient model for
      // ordinary prompts, but must yield to slash-command frontmatter tiers.
      // No providerId: automatic selections keep the bare id, so an
      // operator's defaultProvider config still applies to them as intended.
      set((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({
          ...inst,
          modelOverride: model,
          modelOverrideSource: 'automatic',
          modelOverrideProviderId: null,
        })),
      }))
    },

    setTabPillColor: (tabId, color) => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, pillColor: color } : t
        ),
      }))
      // Push a lightweight desktop_tab_meta delta so iOS sees the pill color
      // change immediately without waiting for the 5 s snapshot poll tick.
      // color is null when the customization is explicitly cleared — that
      // null rides through unchanged so the delta clears it on iOS too.
      tabMetaChanged({ tabId, pillColor: color })
    },

    clearTab: () => {
      const { activeTabId } = get()
      // Conversation state (messages, permissionQueue, permissionDenied) resets
      // on the active instance; tab-level run state (lastResult, currentActivity,
      // queuedPrompts) resets on the tab.
      set((s) => {
        const conversationPanes = commitInstance(s.conversationPanes, activeTabId, (inst) => ({
          ...inst,
          messages: [],
          permissionQueue: [],
          elicitationQueue: [],
          permissionDenied: null,
        }))
        const tabs = s.tabs.map((t) =>
          t.id === activeTabId
            ? { ...t, lastResult: null, currentActivity: '', queuedPrompts: [] }
            : t
        )
        return { tabs, conversationPanes }
      })
    },


    setWorktreeUncommitted: setWorktreeUncommittedAction(set, get),

    addSystemMessage: addSystemMessageAction(set, get),
  }
}

