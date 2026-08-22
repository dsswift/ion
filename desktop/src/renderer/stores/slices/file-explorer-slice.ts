import type { StoreSet, StoreGet, State } from '../session-store-types'

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
