import type { TabState } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import { destroyTerminalInstance } from '../../components/TerminalPanel'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, isBlankConversationTab, initialModelOverride } from '../session-store-helpers'
import { makeMainPane, commitInstance, activeInstance, instanceMessageCount } from '../conversation-instance'
import { cleanupTabDeltas } from './engine-event-slice'

export function createTabSlice(set: StoreSet, get: StoreGet): Partial<State> {
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
      const { activeTabId } = get()
      const activeTab = get().tabs.find((t) => t.id === activeTabId)
      if (activeTab?.hasEngineExtension) {
        // Engine tabs: write permissionMode directly onto the active instance.
        const pane = get().conversationPanes.get(activeTabId)
        const instanceId = pane?.activeInstanceId
        if (instanceId) {
          const compoundKey = `${activeTabId}:${instanceId}`
          set((s) => {
            const conversationPanes = new Map(s.conversationPanes)
            const paneInner = conversationPanes.get(activeTabId)
            if (!paneInner) return {}
            const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
            if (idx === -1) return {}
            const instances = paneInner.instances.slice()
            instances[idx] = { ...instances[idx], permissionMode: mode }
            conversationPanes.set(activeTabId, { ...paneInner, instances })
            return { conversationPanes }
          })
          window.ion.engineSetPlanMode(compoundKey, mode === 'plan')
        }
      } else {
        // CLI tabs: set on the parent tab as before.
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === activeTabId ? { ...t, permissionMode: mode } : t
          ),
        }))
        window.ion.setPermissionMode(activeTabId, mode, source)
      }
      // Auto-switch to the plan model when entering plan mode
      const { planModelSplitEnabled, planModeModel } = usePreferencesStore.getState()
      if (planModelSplitEnabled && mode === 'plan' && planModeModel) {
        get().setTabModel(activeTabId, planModeModel)
      }
    },

    createTab: async (useWorktree) => {
      const homeDir = get().staticInfo?.homePath || '~'
      const defaultBase = usePreferencesStore.getState().defaultBaseDirectory
      const startDir = defaultBase || homeDir
      const hasChosen = !!defaultBase

      const existingBlank = get().tabs.find(
        (t) => isBlankConversationTab(t, startDir, instanceMessageCount(activeInstance(get().conversationPanes, t.id)))
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
        conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({ modelOverride: initialModelOverride() })),
        activeTabId: tab.id,
        tallViewTabId: usePreferencesStore.getState().defaultTallConversation ? tab.id : null,
        terminalTallTabId: null,
      }))
      window.ion.setPermissionMode(tabId, tab.permissionMode, 'tab_create')
      return tabId
    },

    createTabInDirectory: async (dir, useWorktree, skipDuplicateCheck, pinToGroupId) => {
      if (!skipDuplicateCheck) {
        const existingBlank = get().tabs.find((t) => isBlankConversationTab(t, dir, instanceMessageCount(activeInstance(get().conversationPanes, t.id))))
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

      let tabId: string
      try {
        const res = await window.ion.createTab()
        tabId = res.tabId
      } catch {
        tabId = crypto.randomUUID()
      }

      const { tabGroupMode: tgm2, tabGroups: tgs2 } = usePreferencesStore.getState()
      const defaultGroupId2 = tgm2 === 'manual' ? (tgs2.find((g) => g.isDefault)?.id || tgs2[0]?.id || null) : null

      // If caller explicitly requested a pinned group (e.g. iOS per-group "+" button
      // or desktop "Move to group and pin"), honor it: place the tab in that group
      // and set groupPinned=true from the start so the first sendMessage's
      // auto-movement (gated on !groupPinned in send-slice.ts) skips this tab.
      const useExplicitPin = !!pinToGroupId && tgm2 === 'manual'
      const finalGroupId = useExplicitPin ? pinToGroupId! : defaultGroupId2
      const finalPinned = useExplicitPin ? true : false
      if (useExplicitPin) {
        console.log(`[tab-pin] createTabInDirectory pinToGroupId=${pinToGroupId} overriding default group ${defaultGroupId2 ?? 'none'} for tab=${tabId.slice(0, 8)}`)
      }

      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        workingDirectory: dir,
        hasChosenDirectory: true,
        groupId: finalGroupId,
        groupPinned: finalPinned,
      }

      if (useWorktree) {
        const { isRepo } = await window.ion.gitIsRepo(dir)
        if (isRepo) {
          const defaults = usePreferencesStore.getState().worktreeBranchDefaults
          const defaultBranch = defaults[dir]
          if (defaultBranch) {
            const result = await window.ion.gitWorktreeAdd(dir, defaultBranch)
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
        conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({ modelOverride: initialModelOverride() })),
        activeTabId: tab.id,
        tallViewTabId: usePreferencesStore.getState().defaultTallConversation ? tab.id : null,
        terminalTallTabId: null,
      }))
      window.ion.setPermissionMode(tabId, tab.permissionMode, 'tab_create')
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
        const shouldTall = targetTab && !targetTab.isTerminalOnly && (
          (targetTab.hasEngineExtension && prefs.defaultTallEngine) ||
          (!targetTab.hasEngineExtension && prefs.defaultTallConversation)
        )
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
      // Publish focused session key as a workspace resource so extensions
      // can route notifications to the active tab. Fire-and-forget.
      window.ion.notifyTabFocus(tabId)

      // If skeleton tab (messages not yet loaded), load them asynchronously.
      // Skeleton state now lives on the active instance: a persisted
      // messageCount > 0 with an empty messages array means the scrollback
      // hasn't been hydrated from disk yet.
      const targetTabAfter = get().tabs.find(t => t.id === tabId)
      if (targetTabAfter?.conversationId) {
        const inst = activeInstance(get().conversationPanes, tabId)
        if (inst && inst.messages.length === 0 && (inst.messageCount ?? 0) > 0) {
          get().loadSkeletonMessages(tabId)
        }
      }
    },

    closeTab: (tabId) => {
      const closingTab = get().tabs.find((t) => t.id === tabId)
      // ─── Action-layer guard: hard-block engine tab close while
      // orchestrator is running OR dispatched background agents are
      // still executing. Mirrors the X-button suppression in
      // TabStripTabPill.tsx and exists for defense-in-depth — catches
      // keyboard shortcuts (Cmd+W → CloseTabConfirmDialog), group-pill
      // close paths, and any future entry point we haven't enumerated.
      //
      // No escape hatch: there is no `force` flag. Either the tab is
      // completely idle (no orchestrator activity, no dispatched
      // background children) and close is allowed, or the tab is
      // active and the user must stop it first (via the in-pane
      // Interrupt button, or by waiting for natural completion). The
      // user's path to close an active engine tab is: interrupt →
      // wait for idle → close. This protects dispatched background
      // agents from accidental SIGTERM via tab close.
      //
      // Internal cleanup paths (`removeEngineInstance` last-instance
      // close, `moveEngineInstance` source-cleanup) abort the
      // orchestrator above the call site, which propagates to
      // children — by the time those paths reach this guard, the
      // tab's state should already be quiescent. If a race window
      // means agents haven't yet flipped to terminal status, the
      // guard fires, the warn is logged, and the next snapshot tick
      // (after agents finish aborting) allows the close.
      //
      // CLI tabs are intentionally NOT gated — CLI tabs have no
      // dispatched-agent concept and their existing Cmd+W → confirm
      // flow is correct as-is. The guard is engine-tab-only because
      // engine tabs are where the dispatched-agent kill footgun lives.
      if (closingTab?.hasEngineExtension) {
        const s = get() as any
        const pane = s.conversationPanes?.get?.(tabId)
        if (pane && pane.instances) {
          let orchestratorRunning = false
          const childCounts: Array<{ id: string; count: number }> = []
          for (const inst of pane.instances) {
            const state = inst.statusFields?.state
            if (state === 'running' || state === 'connecting' || state === 'starting') {
              orchestratorRunning = true
            }
            const agents = inst.agentStates || []
            const running = agents.filter((a: any) => a?.status === 'running').length
            childCounts.push({ id: inst.id, count: running })
          }
          const childRunning = childCounts.some((c) => c.count > 0)
          if (orchestratorRunning || childRunning) {
            console.warn(
              `[closeTab] refused engine tab close: tabId=${tabId.slice(0, 8)} ` +
              `orchestratorRunning=${orchestratorRunning} ` +
              `childCounts=${JSON.stringify(childCounts.map((c) => `${c.id.slice(0, 6)}:${c.count}`))}` +
              ' — user must stop the tab (interrupt + wait for children) before closing'
            )
            return
          }
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
      if (termIds.has(tabId)) {
        const next = new Set(termIds)
        next.delete(tabId)
        set({ terminalOpenTabIds: next, terminalPanes: panes })
      } else {
        set({ terminalPanes: panes })
      }
      if (closingTab?.hasEngineExtension) {
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
        const newActive = remaining[Math.min(closedIndex, remaining.length - 1)]
        set({ tabs: remaining, activeTabId: newActive.id })
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

    moveTabToGroup: (tabId, groupId) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (!tab) return s
        const updated = { ...tab, groupId }
        const without = s.tabs.filter((t) => t.id !== tabId)
        let insertIdx = -1
        for (let i = without.length - 1; i >= 0; i--) {
          if (without[i].groupId === groupId) { insertIdx = i; break }
        }
        const newTabs = [...without]
        if (insertIdx >= 0) {
          newTabs.splice(insertIdx + 1, 0, updated)
        } else {
          newTabs.push(updated)
        }
        return { tabs: newTabs }
      })
    },

    // Combined "move and pin": same reordering as moveTabToGroup but also
    // sets groupPinned=true in the same set() call. Used by the desktop
    // "Move to group and pin" context-menu item and by iOS's matching
    // command. Setting both fields in one update avoids the two-render
    // flicker of calling moveTabToGroup then toggleTabGroupPin in sequence,
    // and — more importantly — guarantees that any send-slice auto-movement
    // observing the store sees groupPinned=true atomically with the group
    // change, so it can never race in the half-pinned state.
    moveTabToGroupAndPin: (tabId, groupId) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (!tab) return s
        console.log(`[tab-pin] move+pin tab=${tabId.slice(0, 8)} → group=${groupId} (was group=${tab.groupId ?? 'none'}, pinned=${tab.groupPinned ?? false})`)
        const updated = { ...tab, groupId, groupPinned: true }
        const without = s.tabs.filter((t) => t.id !== tabId)
        let insertIdx = -1
        for (let i = without.length - 1; i >= 0; i--) {
          if (without[i].groupId === groupId) { insertIdx = i; break }
        }
        const newTabs = [...without]
        if (insertIdx >= 0) {
          newTabs.splice(insertIdx + 1, 0, updated)
        } else {
          newTabs.push(updated)
        }
        return { tabs: newTabs }
      })
    },

    setTabGroupId: (tabId, groupId) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (!tab) return s
        const updated = { ...tab, groupId }
        const without = s.tabs.filter((t) => t.id !== tabId)
        let insertIdx = -1
        for (let i = without.length - 1; i >= 0; i--) {
          if (without[i].groupId === groupId) { insertIdx = i; break }
        }
        const newTabs = [...without]
        if (insertIdx >= 0) {
          newTabs.splice(insertIdx + 1, 0, updated)
        } else {
          newTabs.push(updated)
        }
        return { tabs: newTabs }
      })
    },

    toggleTabGroupPin: (tabId) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (!tab) return s
        const newPinned = !tab.groupPinned
        console.log(`[tab-pin] tab=${tabId.slice(0, 8)} groupPinned: ${tab.groupPinned} → ${newPinned} currentGroup=${tab.groupId ?? 'none'}`)
        return {
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, groupPinned: newPinned } : t
          ),
        }
      })
    },

    setWorktreeUncommitted: (tabId, hasChanges) => {
      const map = new Map(get().worktreeUncommittedMap)
      map.set(tabId, hasChanges)
      set({ worktreeUncommittedMap: map })
    },

    addSystemMessage: (content) => {
      const { activeTabId } = get()
      // System messages append onto the active conversation instance now.
      set((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, activeTabId, (inst) => ({
          ...inst,
          messages: [
            ...inst.messages,
            { id: `msg-${Date.now()}-${Math.random()}`, role: 'system' as const, content, timestamp: Date.now() },
          ],
        })),
      }))
    },
  }
}

