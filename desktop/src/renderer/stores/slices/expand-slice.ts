import type { StoreSet, StoreGet, State } from '../session-store-types'

export function createExpandSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    toggleExpanded: () => {
      const { activeTabId, isExpanded } = get()
      const willExpand = !isExpanded
      set((s) => ({
        isExpanded: willExpand,
        settingsOpen: false,
        tabs: willExpand
          ? s.tabs.map((t) => t.id === activeTabId ? { ...t, hasUnread: false } : t)
          : s.tabs,
      }))
    },

    toggleTallView: (tabId) => {
      set((s) => ({
        tallViewTabId: s.tallViewTabId === tabId ? null : tabId,
        // A manual tall toggle always clears the auto-suspend marker — never
        // restore on the next terminal-close after the user has explicitly
        // re-entered or exited tall mode themselves.
        suspendedTallTabId: null,
        ...(s.tallViewTabId !== tabId ? { terminalTallTabId: null } : {}),
      }))
    },

    openSettings: (tab?: string) => set({ settingsOpen: true, settingsInitialTab: tab ?? null }),
    closeSettings: () => set({ settingsOpen: false, settingsInitialTab: null }),

    incOpenFloatingPanelCount: () => set((s) => ({ openFloatingPanelCount: s.openFloatingPanelCount + 1 })),
    decOpenFloatingPanelCount: () => set((s) => ({ openFloatingPanelCount: Math.max(0, s.openFloatingPanelCount - 1) })),

    toggleGitPanel: () => {
      set((s) => ({ gitPanelOpen: !s.gitPanelOpen }))
    },

    closeGitPanel: () => {
      set({ gitPanelOpen: false })
    },

    toggleStatusDrawer: () => {
      set((s) => ({ statusDrawerOpen: !s.statusDrawerOpen }))
    },

    closeStatusDrawer: () => {
      set({ statusDrawerOpen: false, statusDrawerDispatchId: null })
    },

    // Open the Status Drawer and deep-link to a specific dispatch in the
    // dispatch preview. The StatusDrawer reads statusDrawerDispatchId to
    // decide which agent to pre-open in AgentDetailPanel. A null id just
    // opens the drawer without pre-selecting anything.
    openDispatchPreview: (dispatchId: string) => {
      set({ statusDrawerOpen: true, statusDrawerDispatchId: dispatchId })
    },
  }
}
