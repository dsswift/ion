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
import { isManagedWorkspacePath, normalizeProjectDir } from '../shared/project-registry'

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

export function createProjectRegistryActions(set: Set, get: Get): Pick<PreferencesState, 'addProject' | 'removeProject' | 'setDefaultProject' | 'setProjectName' | 'setProjectProfileOverride'> {
  return {
    addProject: (dir) => {
      const key = normalizeProjectDir(dir)
      if (!key.startsWith('/') || isManagedWorkspacePath(key)) return
      const current = get().projects
      if (current[key]) return
      set({ projects: { ...current, [key]: { addedManually: true, lastUsedAt: 0 } } })
      saveSettings(getAllSettings(get))
    },
    removeProject: (dir) => {
      const key = normalizeProjectDir(dir)
      const current = get().projects
      if (!(key in current)) return
      const next = { ...current }
      delete next[key]
      set({ projects: next })
      saveSettings(getAllSettings(get))
    },
    setDefaultProject: (dir) => {
      const key = dir ? normalizeProjectDir(dir) : null
      const current = get().projects
      set({ projects: Object.fromEntries(Object.entries(current).map(([path, entry]) => [path, { ...entry, isDefault: path === key }])) })
      saveSettings(getAllSettings(get))
    },
    setProjectName: (dir, name) => {
      const key = normalizeProjectDir(dir)
      const entry = get().projects[key]
      if (!entry) return
      const normalized = name?.trim()
      set({ projects: { ...get().projects, [key]: { ...entry, ...(normalized ? { name: normalized } : { name: undefined }) } } })
      saveSettings(getAllSettings(get))
    },
    setProjectProfileOverride: (dir, profileOverride) => {
      const key = normalizeProjectDir(dir)
      const entry = get().projects[key]
      if (!entry) return
      set({ projects: { ...get().projects, [key]: { ...entry, ...(profileOverride ? { profileOverride } : { profileOverride: undefined }) } } })
      saveSettings(getAllSettings(get))
    },
  }
}
