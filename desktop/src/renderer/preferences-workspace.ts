/**
 * Workspace-folder preference actions (multi-root explorer + git panel),
 * extracted from preferences.ts to keep it under the file-size cap.
 *
 * The workspaceFolders setting is PER-PROJECT (D3): normalized primary dir
 * → extra roots. Removal also prunes the removed root's persisted
 * git-panel collapse state.
 */
import type { PreferencesState } from './preferences-types'
import { saveSettings, getAllSettings } from './preferences-persist'
import { normalizeWorkspacePath } from '../shared/workspace-roots'
import { normalizeProjectDir, registerProjectUse as registerUse } from '../shared/project-registry'

type Set = (partial: Partial<PreferencesState>) => void
type Get = () => PreferencesState

export function createWorkspaceFolderActions(set: Set, get: Get): Pick<PreferencesState, 'addWorkspaceFolder' | 'removeWorkspaceFolder' | 'setGitPanelRepoSectionCollapsed'> {
  return {
    addWorkspaceFolder: (primaryDir, dir) => {
      const primary = normalizeWorkspacePath(primaryDir)
      const entry = normalizeWorkspacePath(dir)
      if (!primary.startsWith('/') || !entry.startsWith('/') || entry === primary) return
      const current = get().workspaceFolders
      const list = current[primary] ?? []
      if (list.includes(entry)) return
      set({ workspaceFolders: { ...current, [primary]: [...list, entry] } })
      saveSettings(getAllSettings(get))
    },
    removeWorkspaceFolder: (primaryDir, dir) => {
      const primary = normalizeWorkspacePath(primaryDir)
      const entry = normalizeWorkspacePath(dir)
      const current = get().workspaceFolders
      const list = current[primary]
      if (!list) return
      const next = { ...current }
      const filtered = list.filter((d) => d !== entry)
      if (filtered.length > 0) next[primary] = filtered
      else delete next[primary]
      // Prune the removed root's persisted collapse state too.
      const collapsed = { ...get().gitPanelRepoSectionsCollapsed }
      delete collapsed[entry]
      set({ workspaceFolders: next, gitPanelRepoSectionsCollapsed: collapsed })
      saveSettings(getAllSettings(get))
    },
    setGitPanelRepoSectionCollapsed: (dir, isCollapsed) => {
      const key = normalizeWorkspacePath(dir)
      set({ gitPanelRepoSectionsCollapsed: { ...get().gitPanelRepoSectionsCollapsed, [key]: isCollapsed } })
      saveSettings(getAllSettings(get))
    },
  }
}

export function createInboxPreferenceActions(set: Set, get: Get): Pick<PreferencesState, 'setInboxAutoSettleDays' | 'setInboxAutoSettleOnMerge' | 'setConversationNav' | 'setGitWatcherIgnoredDirectories'> {
  return {
    setGitWatcherIgnoredDirectories: (dirs) => {
      set({ gitWatcherIgnoredDirectories: dirs })
      saveSettings(getAllSettings(get))
    },
    setInboxAutoSettleDays: (days) => {
      set({ inboxAutoSettleDays: Math.min(90, Math.max(0, Math.round(days))) })
      saveSettings(getAllSettings(get))
    },
    setInboxAutoSettleOnMerge: (enabled) => {
      set({ inboxAutoSettleOnMerge: enabled })
      saveSettings(getAllSettings(get))
    },
    setConversationNav: (nav) => {
      set({ conversationNav: nav })
      saveSettings(getAllSettings(get))
    },
  }
}

export function createProjectRegistryActions(set: Set, get: Get): Pick<PreferencesState, 'registerProjectUse' | 'addProject' | 'removeProject'> {
  return {
    registerProjectUse: (dir) => {
      const next = registerUse(get().projects, dir, Date.now())
      if (next === get().projects) return // identity short-circuit (rate-limited bump)
      set({ projects: next })
      saveSettings(getAllSettings(get))
    },
    addProject: (dir) => {
      const key = normalizeProjectDir(dir)
      if (!key.startsWith('/')) return
      const current = get().projects
      set({ projects: { ...current, [key]: { ...(current[key] ?? {}), addedManually: true, lastUsedAt: current[key]?.lastUsedAt ?? Date.now() } } })
      saveSettings(getAllSettings(get))
    },
    removeProject: (dir) => {
      const key = normalizeProjectDir(dir)
      const current = get().projects
      if (!(key in current)) return
      const next = { ...current }
      delete next[key]
      // Remove hides from pickers only: conversations are untouched, and the
      // registerProjectUse seam re-adds the dir the next time a conversation
      // uses it (documented semantic).
      set({ projects: next })
      saveSettings(getAllSettings(get))
    },
  }
}
