import type { StoreSet, StoreGet, State } from '../session-store-types'
import { rDebug } from '../../rendererLogger'

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

    // ── At most one right-side panel ──────────────────────────────────────────
    //
    // The git panel and the Status Drawer both anchor to the right edge of the
    // content column. Open together they need the git panel's width plus the
    // drawer's, which runs off the side of a smaller display -- so opening
    // either one closes the other.
    //
    // The rule lives HERE rather than in the components that trigger it because
    // there are four triggers already (StatusBarGitButton, the context ring,
    // a dispatch row, the keyboard) and a component handler only holds for the
    // window it is mounted in -- the ATV mirror runs these same actions. One
    // invariant at the mutation point covers every caller, present and future.
    //
    // Exclusivity fires on OPEN only. Closing a panel says nothing about the
    // other one, so a close never resurrects its sibling and never force-closes
    // it either.
    //
    // Both arms of each toggle log. The operator-visible symptom of this
    // invariant is "my git panel vanished when I pressed Cmd+4" -- a panel
    // closing because something else opened is indistinguishable from a bug
    // unless the displacement is in the log.

    toggleGitPanel: () => {
      set((s) => {
        if (s.gitPanelOpen) {
          rDebug('panels', 'toggleGitPanel: closing', { displaced_drawer: false })
          return { gitPanelOpen: false }
        }
        rDebug('panels', 'toggleGitPanel: opening', { displaced_drawer: s.statusDrawerOpen })
        return { gitPanelOpen: true, statusDrawerOpen: false, statusDrawerDispatchId: null }
      })
    },

    closeGitPanel: () => {
      set({ gitPanelOpen: false })
    },

    toggleStatusDrawer: () => {
      set((s) => {
        if (s.statusDrawerOpen) {
          rDebug('panels', 'toggleStatusDrawer: closing', { displaced_git_panel: false })
          return { statusDrawerOpen: false }
        }
        rDebug('panels', 'toggleStatusDrawer: opening', { displaced_git_panel: s.gitPanelOpen })
        return { statusDrawerOpen: true, gitPanelOpen: false }
      })
    },

    closeStatusDrawer: () => {
      set({ statusDrawerOpen: false, statusDrawerDispatchId: null })
    },

    // Open the Status Drawer and deep-link to a specific dispatch in the
    // dispatch preview. The StatusDrawer reads statusDrawerDispatchId to
    // decide which agent to pre-open in AgentDetailPanel. A null id just
    // opens the drawer without pre-selecting anything.
    //
    // This is the drawer's second opener, so it carries the same exclusivity as
    // toggleStatusDrawer -- a deep-link from a dispatch row must not leave the
    // drawer stacked beside an open git panel.
    openDispatchPreview: (dispatchId: string) => {
      set((s) => {
        rDebug('panels', 'openDispatchPreview', {
          dispatch_id: dispatchId,
          displaced_git_panel: s.gitPanelOpen,
        })
        return { statusDrawerOpen: true, statusDrawerDispatchId: dispatchId, gitPanelOpen: false }
      })
    },
  }
}
