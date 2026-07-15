import type { TabState } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import { destroyTerminalInstance } from '../../components/TerminalPanel'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, isReusableBlankConversationTab, initialModelOverride, initialPermissionMode } from '../session-store-helpers'
import { makeMainPane, commitInstance, activeInstance, instanceMessageCount, needsHistoryHydration } from '../conversation-instance'
import { cleanupTabDeltas } from './engine-event-slice'
import { applySetThinkingEffort } from './tab-slice-thinking'
import { applyPermissionModeForTab } from './tab-slice-permission-mode'
import { createConversationTabAction } from './engine-slice-create'
import { evaluateCloseGuard, formatCloseGuardRefusal } from './tab-close-guard'
import { pickNextActiveTab } from './tab-slice-next-active'
import { getEffectiveTabGroups } from '../../preferences'
import { rDebug, rWarn } from '../../rendererLogger'
import {
  moveTabToGroupAction, moveTabToGroupAndPinAction, setTabGroupIdAction,
  toggleTabGroupPinAction, setWorktreeUncommittedAction, addSystemMessageAction,
} from './tab-slice-misc-actions'

export function createTabSlice(set: StoreSet, get: StoreGet): Partial<State> {
  // Unified creation entry point (Phase 2, #256). Both plain and engine tabs
  // go through this path. createTabInDirectory delegates here for base
  // creation and then applies its extra options (worktree, pin, duplicate
  // check, recent-dir tracking) on top.
  const createConversationTab = createConversationTabAction(set, get)

  return {
    initStaticInfo: async () => {
      try {
        const result = await window.ion.start()
        const backend = await window.ion.getBackend()
        set({
          staticInfo: {
            version: result.version || 'unknown',
            email: result.auth?.email || null,
            subscriptionType: result.auth?.subscriptionType || null,
            projectPath: result.projectPath || '~',
            homePath: result.homePath || '~',
          },
          backend,
        })
      } catch {}
    },

    setPermissionMode: (mode, source) => {
      // Active-tab UI entry point; the per-tab core lives in
      // tab-slice-permission-mode.ts so pipelines with an explicit tabId
      // (implement-slice) share the exact same flip.
      applyPermissionModeForTab(set, get, get().activeTabId, mode, source)
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
        const tallConv = usePreferencesStore.getState().defaultTallConversation
        set({
          activeTabId: existingBlank.id,
          tallViewTabId: tallConv ? existingBlank.id : null,
          terminalTallTabId: null,
        })
        return existingBlank.id
      }

      let tabId: string
      try {
        const res = await window.ion.createTab()
        tabId = res.tabId
      } catch {
        tabId = crypto.randomUUID()
      }

      const { tabGroupMode, tabGroups } = usePreferencesStore.getState()
      const defaultGroupId = tabGroupMode === 'manual' ? (tabGroups.find((g) => g.isDefault)?.id || tabGroups[0]?.id || null) : null

      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        workingDirectory: startDir,
        hasChosenDirectory: hasChosen,
        groupId: defaultGroupId,
      }

      if (useWorktree) {
        const { isRepo } = await window.ion.gitIsRepo(startDir)
        if (isRepo) {
          const defaults = usePreferencesStore.getState().worktreeBranchDefaults
          const defaultBranch = defaults[startDir]
          if (defaultBranch) {
            const result = await window.ion.gitWorktreeAdd(startDir, defaultBranch)
            if (result.ok && result.worktree) {
              tab.worktree = result.worktree
              tab.workingDirectory = result.worktree.worktreePath
            }
          } else {
            tab.pendingWorktreeSetup = true
          }
        }
      }

      set((s) => ({
        tabs: [...s.tabs, tab],
        // Seed the single-instance `main` pane so message/draft/model state has
        // a home from creation (2A invariant). Carry the plan-model split
        // override onto the instance since modelOverride no longer lives on the tab.
        conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({ modelOverride: initialModelOverride(), permissionMode: initialPermissionMode() })),
        activeTabId: tab.id,
        tallViewTabId: usePreferencesStore.getState().defaultTallConversation ? tab.id : null,
        terminalTallTabId: null,
      }))
      window.ion.setPermissionMode(tabId, initialPermissionMode(), 'tab_create')
      return tabId
    },

    createTabInDirectory: async (dir, useWorktree, skipDuplicateCheck, pinToGroupId) => {
      if (!skipDuplicateCheck) {
        const existingBlank = get().tabs.find((t) => isReusableBlankConversationTab(t, dir, instanceMessageCount(activeInstance(get().conversationPanes, t.id))))
        if (existingBlank) {
          const tallConv = usePreferencesStore.getState().defaultTallConversation
          set({
            activeTabId: existingBlank.id,
            tallViewTabId: tallConv ? existingBlank.id : null,
            terminalTallTabId: null,
          })
          return existingBlank.id
        }
      }

      usePreferencesStore.getState().addRecentBaseDirectory(dir)
      usePreferencesStore.getState().incrementDirectoryUsage(dir)

      // Base tab + pane creation via the unified path (Phase 2, #256).
      // createConversationTab gets the real tab ID from the main process,
      // seeds the main pane with a session-start divider, sets active tab,
      // and calls window.ion.setPermissionMode. We then apply the extra
      // options that are specific to this entry point (worktree, group pin).
      const tabId = await createConversationTab(dir, { setActive: true })

      // Apply group pin if explicitly requested (iOS per-group "+" button or
      // desktop "Move to group and pin"). Override the group placement that
      // createConversationTab wrote (it used the default group) with the
      // caller's requested group + pinned=true.
      const { tabGroupMode: tgm2, tabGroups: _tgs2 } = usePreferencesStore.getState()
      const useExplicitPin = !!pinToGroupId && tgm2 === 'manual'
      if (useExplicitPin) {
        rDebug('tab.pin', 'createTabInDirectory: pinning to group', { pin_to_group: pinToGroupId, tab_id: tabId.slice(0, 8) })
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, groupId: pinToGroupId!, groupPinned: true } : t
          ),
        }))
      }

      // Worktree setup (unchanged from prior implementation).
      if (useWorktree) {
        const { isRepo } = await window.ion.gitIsRepo(dir)
        if (isRepo) {
          const defaults = usePreferencesStore.getState().worktreeBranchDefaults
          const defaultBranch = defaults[dir]
          if (defaultBranch) {
            const result = await window.ion.gitWorktreeAdd(dir, defaultBranch)
            if (result.ok && result.worktree) {
              set((s) => ({
                tabs: s.tabs.map((t) =>
                  t.id === tabId
                    ? { ...t, worktree: result.worktree!, workingDirectory: result.worktree!.worktreePath }
                    : t
                ),
              }))
            }
          } else {
            set((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId ? { ...t, pendingWorktreeSetup: true } : t
              ),
            }))
          }
        }
      }

      return tabId
    },

    selectTab: (tabId) => {
      const s = get()
      if (tabId === s.activeTabId) {
        if (!s.isExpanded) {
          set((prev) => ({
            isExpanded: true,
            settingsOpen: false,
            tabs: prev.tabs.map((t) => t.id === tabId ? { ...t, hasUnread: false } : t),
          }))
        }
        return
      }
      const prefs = usePreferencesStore.getState()
      const expandOnSwitch = prefs.expandOnTabSwitch
      set((prev) => {
        const targetTab = prev.tabs.find(t => t.id === tabId)
        const isTerminalOnlyTall = targetTab?.isTerminalOnly && prefs.defaultTallTerminal
        // One tall-default for every conversation tab — plain or
        // extension-backed (the engine-specific default was collapsed away).
        const shouldTall = targetTab && !targetTab.isTerminalOnly && prefs.defaultTallConversation
        return {
          activeTabId: tabId,
          isExpanded: expandOnSwitch ? true : prev.isExpanded,
          tallViewTabId: shouldTall ? tabId : null,
          terminalTallTabId: isTerminalOnlyTall ? tabId : null,
          settingsOpen: false,
          tabs: prev.tabs.map((t) =>
            t.id === tabId ? { ...t, hasUnread: false } : t
          ),
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
          get().loadSkeletonMessages(tabId)
        }
      }
    },

    closeTab: (tabId) => {
      const closingTab = get().tabs.find((t) => t.id === tabId)
      // Action-layer guard: hard-block close while the orchestrator or any
      // dispatched background agent is still running. TAB-TYPE-AGNOSTIC — see
      // evaluateCloseGuard in tab-close-guard.ts for the full rationale (plain
      // conversations can dispatch sub-agents too, so this is not engine-only).
      if (closingTab) {
        const pane = get().conversationPanes.get(tabId)
        const guard = evaluateCloseGuard(pane)
        if (guard.blocked) {
          rWarn('tab.close', 'close blocked by guard', { tab_id: tabId, reason: formatCloseGuardRefusal(tabId, guard) })
          return
        }
      }
      if (closingTab?.worktree) {
        window.ion.gitWorktreeRemove(
          closingTab.worktree.repoPath,
          closingTab.worktree.worktreePath,
          closingTab.worktree.branchName,
          true,
        ).catch(() => {})
      }
      window.ion.closeTab(tabId).catch(() => {})
      const pane = get().terminalPanes.get(tabId)
      if (pane) {
        for (const inst of pane.instances) {
          const key = `${tabId}:${inst.id}`
          window.ion.terminalDestroy(key).catch(() => {})
          destroyTerminalInstance(key)
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
        const engineUsage = new Map(get().engineUsage)
        const conversationPanes = new Map(get().conversationPanes)
        for (const k of engineWorkingMessages.keys()) if (k === tabId || k.startsWith(`${tabId}:`)) engineWorkingMessages.delete(k)
        for (const k of engineNotifications.keys()) if (k === tabId || k.startsWith(`${tabId}:`)) engineNotifications.delete(k)
        for (const k of engineDialogs.keys()) if (k === tabId || k.startsWith(`${tabId}:`)) engineDialogs.delete(k)
        for (const k of enginePinnedPrompt.keys()) if (k === tabId || k.startsWith(`${tabId}:`)) enginePinnedPrompt.delete(k)
        for (const k of engineUsage.keys()) if (k === tabId || k.startsWith(`${tabId}:`)) engineUsage.delete(k)
        conversationPanes.delete(tabId)
        set({ engineWorkingMessages, engineNotifications, engineDialogs, enginePinnedPrompt, engineUsage, conversationPanes })
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

      // Remove closed tab from stashed manual tab assignments
      const stashedAssignments = usePreferencesStore.getState().stashedManualTabAssignments
      if (stashedAssignments[tabId]) {
        const updatedAssignments = { ...stashedAssignments }
        delete updatedAssignments[tabId]
        usePreferencesStore.getState().setStashedManualGroups(
          usePreferencesStore.getState().stashedManualGroups,
          updatedAssignments,
        )
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
          // Seed the single-instance `main` pane for the replacement tab so its
          // message/draft/model state has a home (2A invariant).
          set({
            tabs: [newTab],
            activeTabId: newTab.id,
            gitPanelOpen: false,
            conversationPanes: new Map(get().conversationPanes).set(newTab.id, makeMainPane({ modelOverride: initialModelOverride() })),
          })
          return
        }
        const closedIndex = s.tabs.findIndex((t) => t.id === tabId)
        // Group-aware next-active choice: prefer the nearest remaining sibling in
        // the closed tab's derived group, falling back to nearest-by-flat-index.
        // See tab-slice-next-active.ts for the selection rules.
        const { tabGroupMode, tabGroups } = usePreferencesStore.getState()
        const newActiveId =
          pickNextActiveTab(tabId, s.tabs, {
            mode: tabGroupMode,
            groups: getEffectiveTabGroups(tabGroups),
          }) ?? remaining[Math.min(closedIndex, remaining.length - 1)].id
        // Commit the tab removal first so selectTab's `tabs.find` resolves the
        // new target, then route activation through selectTab — the single,
        // authoritative tab-activation path. This hydrates a skeleton existing
        // conversation (loadSkeletonMessages), seeds tall view, clears unread,
        // and fires the focus notification. A prior raw `set({ activeTabId })`
        // here bypassed all of that and left the activated tab in a limbo state
        // (empty scrollback + plan card). activeTabId is still the closing tab
        // at this point, so selectTab's same-id early-return does not trip.
        set({ tabs: remaining })
        get().selectTab(newActiveId)
      } else {
        set({ tabs: remaining })
      }
    },

    reorderTabs: (reorderedTabs) => {
      set({ tabs: reorderedTabs })
    },

    renameTab: (tabId, customTitle) => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, customTitle } : t
        ),
      }))
      const tab = get().tabs.find((t) => t.id === tabId)
      if (tab?.conversationId) {
        void window.ion.saveSessionLabel(tab.conversationId, customTitle)
      }
      // Push a lightweight desktop_tab_meta delta so iOS sees the renamed tab
      // immediately without waiting for the 5 s snapshot poll tick.
      const display = customTitle ?? get().tabs.find((t) => t.id === tabId)?.title
      if (display !== undefined) {
        window.ion.tabMetaChanged({ tabId, title: display })
      }
    },

    setTabModel: (tabId, model) => {
      // modelOverride now lives on the active conversation instance.
      set((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({ ...inst, modelOverride: model })),
      }))
    },

    setTabPillColor: (tabId, color) => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, pillColor: color } : t
        ),
      }))
    },

    setTabPillIcon: (tabId, icon) => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, pillIcon: icon } : t
        ),
      }))
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

    moveTabToGroup: moveTabToGroupAction(set),

    // Combined "move and pin": same reordering as moveTabToGroup but also
    // sets groupPinned=true in the same set() call. Used by the desktop
    // "Move to group and pin" context-menu item and by iOS's matching
    // command. Setting both fields in one update avoids the two-render
    // flicker of calling moveTabToGroup then toggleTabGroupPin in sequence,
    // and — more importantly — guarantees that any send-slice auto-movement
    // observing the store sees groupPinned=true atomically with the group
    // change, so it can never race in the half-pinned state.
    moveTabToGroupAndPin: moveTabToGroupAndPinAction(set),

    setTabGroupId: setTabGroupIdAction(set),

    toggleTabGroupPin: toggleTabGroupPinAction(set),

    setWorktreeUncommitted: setWorktreeUncommittedAction(set, get),

    addSystemMessage: addSystemMessageAction(set, get),
  }
}

