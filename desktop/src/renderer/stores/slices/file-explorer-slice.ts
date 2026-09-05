import type { StoreSet, StoreGet, State } from '../session-store-types'
import { pruneExpandedChildren } from '../../../shared/explorer-state'

export function createFileExplorerSlice(set: StoreSet, _get: StoreGet): Partial<State> {
  return {
    toggleFileExplorer: (tabId) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (!tab) return {}
        const dir = tab.workingDirectory
        const next = new Set(s.fileExplorerOpenDirs)
        if (next.has(dir)) {
          next.delete(dir)
          return { fileExplorerOpenDirs: next }
        }
        next.add(dir)
        return { fileExplorerOpenDirs: next, inboxPanelOpen: false }
      })
    },

    setFileExplorerExpanded: (dir, path, expanded) => {
      set((s) => {
        const states = new Map(s.fileExplorerStates)
        const current = states.get(dir) || { expandedPaths: new Set<string>(), selectedPath: null }
        const expandedPaths = new Set(current.expandedPaths)
        if (expanded) expandedPaths.add(path)
        else expandedPaths.delete(path)
        states.set(dir, { ...current, expandedPaths })
        return { fileExplorerStates: states }
      })
    },

    setFileExplorerSelected: (dir, path) => {
      set((s) => {
        const states = new Map(s.fileExplorerStates)
        const current = states.get(dir) || { expandedPaths: new Set<string>(), selectedPath: null }
        states.set(dir, { ...current, selectedPath: path })
        return { fileExplorerStates: states }
      })
    },

    collapseAllExplorer: (dir) => {
      set((s) => {
        const states = new Map(s.fileExplorerStates)
        const current = states.get(dir)
        if (current) states.set(dir, { ...current, expandedPaths: new Set() })
        return { fileExplorerStates: states }
      })
    },

    /**
     * Replace tree state with the main-owned snapshot — the hydration at boot
     * and every change another window made. Whole-state replacement, not a
     * merge: main is the one owner, so a merge would resurrect entries it just
     * pruned or forgot.
     */
    applyExplorerState: (snapshot) => {
      set(() => {
        const states = new Map<string, { expandedPaths: Set<string>; selectedPath: string | null }>()
        for (const [root, paths] of Object.entries(snapshot.expanded)) {
          states.set(root, { expandedPaths: new Set(paths), selectedPath: null })
        }
        for (const [root, selectedPath] of Object.entries(snapshot.selected)) {
          const current = states.get(root)
          if (current) current.selectedPath = selectedPath
          else states.set(root, { expandedPaths: new Set(), selectedPath })
        }
        return {
          fileExplorerStates: states,
          fileExplorerRootCollapsed: new Set(snapshot.collapsedRoots),
        }
      })
    },

    /**
     * Forget expanded children of `dir` that the listing just read no longer
     * contains. A persisted set otherwise only grows: rename or delete a folder
     * and its path is remembered forever.
     */
    pruneExplorerExpanded: (dir, presentDirectories) => {
      set((s) => {
        // The expansion set is keyed by ROOT and `dir` may be any directory
        // inside one, so every root that could contain it is checked.
        const states = new Map(s.fileExplorerStates)
        let changed = false
        for (const [root, state] of states) {
          if (dir !== root && !dir.startsWith(root.endsWith('/') ? root : `${root}/`)) continue
          const kept = pruneExpandedChildren([...state.expandedPaths], dir, presentDirectories)
          if (kept.length === state.expandedPaths.size) continue
          states.set(root, { ...state, expandedPaths: new Set(kept) })
          changed = true
        }
        return changed ? { fileExplorerStates: states } : {}
      })
    },

    setExplorerRootCollapsed: (rootDir, collapsed) => {
      set((s) => {
        const next = new Set(s.fileExplorerRootCollapsed)
        if (collapsed) next.add(rootDir)
        else next.delete(rootDir)
        return { fileExplorerRootCollapsed: next }
      })
    },
  }
}
