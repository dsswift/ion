import { create } from 'zustand'
import type { TabStatus, NormalizedEvent, EnrichedError, Message, TabState, Attachment, FileAttachment, CatalogPlugin, PluginStatus, PersistedTabState } from '../../shared/types'
import { useThemeStore } from '../theme'
import { destroyTerminalInstance } from '../components/TerminalPanel'
import notificationSrc from '../../../resources/notification.mp3'

export { AVAILABLE_MODELS, getModelDisplayLabel } from './model-labels'

// ─── Store ───

interface StaticInfo {
  version: string
  email: string | null
  subscriptionType: string | null
  projectPath: string
  homePath: string
}

// ─── File Editor Types ───

export interface FileEditorTab {
  id: string
  filePath: string | null
  fileName: string
  content: string
  savedContent: string
  isDirty: boolean
  isReadOnly: boolean
  isPreview: boolean
}

export interface FileEditorDirState {
  activeFileId: string | null
  files: FileEditorTab[]
}

/** Extensions that open editable by default */
const EDITABLE_EXTS = new Set(['.md', '.txt'])

/** Extensions that should NOT open in the editor (native app only) */
const NON_TEXT_EXTS = new Set([
  '.csv', '.docx', '.xlsx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.gif',
  '.svg', '.ico', '.bmp', '.webp', '.tiff', '.zip', '.tar', '.gz', '.7z',
  '.rar', '.dmg', '.app', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
])

export function isTextFile(name: string): boolean {
  const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
  return !NON_TEXT_EXTS.has(ext)
}

function isEditableByDefault(name: string): boolean {
  const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
  return EDITABLE_EXTS.has(ext)
}

let editorFileCounter = 0
const nextEditorFileId = () => `ef-${++editorFileCounter}`

interface State {
  tabs: TabState[]
  activeTabId: string
  /** Global expand/collapse — user-controlled, not per-tab */
  isExpanded: boolean
  /** Global info fetched on startup (not per-session) */
  staticInfo: StaticInfo | null
  /** User's preferred model override (null = use default) */
  preferredModel: string | null
  /** Whether the git side panel is open */
  gitPanelOpen: boolean
  /** Tab IDs with their terminal panel visible */
  terminalOpenTabIds: Set<string>
  /** Tab IDs with file explorer visible */
  fileExplorerOpenTabIds: Set<string>
  /** Per-directory explorer state (expanded nodes, selection). Key = working directory path */
  fileExplorerStates: Map<string, { expandedPaths: Set<string>; selectedPath: string | null }>
  /** Tab IDs with file editor visible */
  fileEditorOpenTabIds: Set<string>
  /** Whether file editor floating window is in the foreground */
  fileEditorFocused: boolean
  /** Per-directory editor state (open files, active file). Key = working directory path */
  fileEditorStates: Map<string, FileEditorDirState>
  /** Global file editor window position and size (persisted across restarts) */
  editorGeometry: { x: number; y: number; w: number; h: number }
  /** Global plan preview window position and size (persisted across restarts) */
  planGeometry: { x: number; y: number; w: number; h: number }
  /** Whether tab restoration has completed (prevents placeholder flash) */
  tabsReady: boolean

  // Settings dialog state
  settingsOpen: boolean

  // Marketplace state
  marketplaceOpen: boolean
  marketplaceCatalog: CatalogPlugin[]
  marketplaceLoading: boolean
  marketplaceError: string | null
  marketplaceInstalledNames: string[]
  marketplacePluginStates: Record<string, PluginStatus>
  marketplaceSearch: string
  marketplaceFilter: string

  // Actions
  initStaticInfo: () => Promise<void>
  setPreferredModel: (model: string | null) => void
  setPermissionMode: (mode: 'ask' | 'auto' | 'plan') => void
  createTab: (useWorktree?: boolean) => Promise<string>
  createTabInDirectory: (dir: string, useWorktree?: boolean) => Promise<string>
  selectTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  reorderTabs: (reorderedTabs: TabState[]) => void
  renameTab: (tabId: string, customTitle: string | null) => void
  setTabPillColor: (tabId: string, color: string | null) => void
  clearTab: () => void
  toggleExpanded: () => void
  openSettings: () => void
  closeSettings: () => void
  toggleMarketplace: () => void
  closeMarketplace: () => void
  toggleGitPanel: () => void
  closeGitPanel: () => void
  toggleTerminal: (tabId: string) => void
  toggleFileExplorer: (tabId: string) => void
  setFileExplorerExpanded: (dir: string, path: string, expanded: boolean) => void
  setFileExplorerSelected: (dir: string, path: string | null) => void
  collapseAllExplorer: (dir: string) => void
  toggleFileEditor: (tabId: string) => void
  focusFileEditor: () => void
  blurFileEditor: () => void
  openFileInEditor: (dir: string, tabId: string, filePath: string) => void
  closeFileEditorTab: (dir: string, fileId: string) => void
  setActiveEditorFile: (dir: string, fileId: string) => void
  createScratchFile: (dir: string) => void
  updateEditorContent: (dir: string, fileId: string, content: string) => void
  markEditorSaved: (dir: string, fileId: string, filePath: string) => void
  reorderEditorFiles: (dir: string, reordered: FileEditorTab[]) => void
  toggleEditorPreview: (dir: string, fileId: string) => void
  toggleEditorReadOnly: (dir: string, fileId: string) => void
  setEditorGeometry: (geo: { x: number; y: number; w: number; h: number }) => void
  setPlanGeometry: (geo: { x: number; y: number; w: number; h: number }) => void
  loadMarketplace: (forceRefresh?: boolean) => Promise<void>
  setMarketplaceSearch: (query: string) => void
  setMarketplaceFilter: (filter: string) => void
  installMarketplacePlugin: (plugin: CatalogPlugin) => Promise<void>
  uninstallMarketplacePlugin: (plugin: CatalogPlugin) => Promise<void>
  buildYourOwn: () => void
  resumeSession: (sessionId: string, title?: string, projectPath?: string) => Promise<string>
  addSystemMessage: (content: string) => void
  startBashCommand: (command: string, execId: string) => { toolMsgId: string; tabId: string }
  completeBashCommand: (tabId: string, toolMsgId: string, command: string, stdout: string, stderr: string, exitCode: number | null) => void
  sendMessage: (prompt: string, projectPath?: string, extraAttachments?: Attachment[]) => void
  respondPermission: (tabId: string, questionId: string, optionId: string) => void
  addDirectory: (dir: string) => void
  removeDirectory: (dir: string) => void
  setBaseDirectory: (dir: string) => void
  setupWorktree: (tabId: string, sourceBranch: string, setAsDefault: boolean) => Promise<void>
  cancelWorktreeSetup: (tabId: string) => void
  finishWorktreeTab: (tabId: string, strategyOverride?: 'merge' | 'pr') => Promise<void>
  addAttachments: (attachments: FileAttachment[]) => void
  removeAttachment: (attachmentId: string) => void
  clearAttachments: () => void
  setDraftInput: (tabId: string, text: string) => void
  handleNormalizedEvent: (tabId: string, event: NormalizedEvent) => void
  handleStatusChange: (tabId: string, newStatus: string, oldStatus: string) => void
  handleError: (tabId: string, error: EnrichedError) => void
}

let msgCounter = 0
const nextMsgId = () => `msg-${++msgCounter}`

// ─── Notification sound (plays when task completes while window is hidden) ───
const notificationAudio = new Audio(notificationSrc)
notificationAudio.volume = 1.0

async function playNotificationIfHidden(): Promise<void> {
  if (!useThemeStore.getState().soundEnabled) return
  try {
    const visible = await window.coda.isVisible()
    if (!visible) {
      notificationAudio.currentTime = 0
      notificationAudio.play().catch(() => {})
    }
  } catch {}
}

function makeLocalTab(): TabState {
  return {
    id: crypto.randomUUID(),
    claudeSessionId: null,
    status: 'idle',
    activeRequestId: null,
    hasUnread: false,
    currentActivity: '',
    permissionQueue: [],
    permissionDenied: null,
    attachments: [],
    draftInput: '',
    messages: [],
    title: 'New Tab',
    customTitle: null,
    lastResult: null,
    sessionModel: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
    additionalDirs: [],
    permissionMode: useThemeStore.getState().defaultPermissionMode,
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    worktree: null,
    pendingWorktreeSetup: false,
  }
}

const initialTab = makeLocalTab()

export const useSessionStore = create<State>((set, get) => ({
  tabs: [initialTab],
  activeTabId: initialTab.id,
  isExpanded: false,
  staticInfo: null,
  preferredModel: null,
  gitPanelOpen: false,
  terminalOpenTabIds: new Set<string>(),
  fileExplorerOpenTabIds: new Set<string>(),
  fileExplorerStates: new Map(),
  fileEditorOpenTabIds: new Set<string>(),
  fileEditorFocused: true,
  fileEditorStates: new Map(),
  editorGeometry: { x: 60, y: 80, w: 680, h: 480 },
  planGeometry: { x: 60, y: 80, w: 720, h: 420 },
  tabsReady: false,

  // Settings dialog
  settingsOpen: false,

  // Marketplace
  marketplaceOpen: false,
  marketplaceCatalog: [],
  marketplaceLoading: false,
  marketplaceError: null,
  marketplaceInstalledNames: [],
  marketplacePluginStates: {},
  marketplaceSearch: '',
  marketplaceFilter: 'All',

  initStaticInfo: async () => {
    try {
      const result = await window.coda.start()
      set({
        staticInfo: {
          version: result.version || 'unknown',
          email: result.auth?.email || null,
          subscriptionType: result.auth?.subscriptionType || null,
          projectPath: result.projectPath || '~',
          homePath: result.homePath || '~',
        },
      })
    } catch {}
  },

  setPreferredModel: (model) => {
    set({ preferredModel: model })
  },

  setPermissionMode: (mode) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId ? { ...t, permissionMode: mode } : t
      ),
    }))
    window.coda.setPermissionMode(activeTabId, mode)
  },

  createTab: async (useWorktree) => {
    const homeDir = get().staticInfo?.homePath || '~'
    const defaultBase = useThemeStore.getState().defaultBaseDirectory
    const startDir = defaultBase || homeDir
    const hasChosen = !!defaultBase
    const { activeTabId: prevTabId, tabs: prevTabs, fileEditorOpenTabIds: prevEditorOpen } = get()
    const prevTab = prevTabs.find((t) => t.id === prevTabId)
    const inheritEditor = prevTab && prevEditorOpen.has(prevTab.id) && prevTab.workingDirectory === startDir

    let tabId: string
    try {
      const res = await window.coda.createTab()
      tabId = res.tabId
    } catch {
      tabId = crypto.randomUUID()
    }

    const tab: TabState = {
      ...makeLocalTab(),
      id: tabId,
      workingDirectory: startDir,
      hasChosenDirectory: hasChosen,
    }

    // If worktree mode requested, check if directory is a git repo
    if (useWorktree) {
      const { isRepo } = await window.coda.gitIsRepo(startDir)
      if (isRepo) {
        const defaults = useThemeStore.getState().worktreeBranchDefaults
        const defaultBranch = defaults[startDir]
        if (defaultBranch) {
          // Auto-create worktree with saved default
          const result = await window.coda.gitWorktreeAdd(startDir, defaultBranch)
          if (result.ok && result.worktree) {
            tab.worktree = result.worktree
            tab.workingDirectory = result.worktree.worktreePath
          }
        } else {
          // Need user to pick a branch
          tab.pendingWorktreeSetup = true
        }
      }
    }

    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      ...(inheritEditor ? { fileEditorOpenTabIds: new Set([...s.fileEditorOpenTabIds, tab.id]) } : {}),
    }))
    return tabId
  },

  createTabInDirectory: async (dir, useWorktree) => {
    useThemeStore.getState().addRecentBaseDirectory(dir)
    const { activeTabId: prevTabId, tabs: prevTabs, fileEditorOpenTabIds: prevEditorOpen } = get()
    const prevTab = prevTabs.find((t) => t.id === prevTabId)
    const inheritEditor = prevTab && prevEditorOpen.has(prevTab.id) && prevTab.workingDirectory === dir

    let tabId: string
    try {
      const res = await window.coda.createTab()
      tabId = res.tabId
    } catch {
      tabId = crypto.randomUUID()
    }

    const tab: TabState = {
      ...makeLocalTab(),
      id: tabId,
      workingDirectory: dir,
      hasChosenDirectory: true,
    }

    // If worktree mode requested, check if directory is a git repo
    if (useWorktree) {
      const { isRepo } = await window.coda.gitIsRepo(dir)
      if (isRepo) {
        const defaults = useThemeStore.getState().worktreeBranchDefaults
        const defaultBranch = defaults[dir]
        if (defaultBranch) {
          const result = await window.coda.gitWorktreeAdd(dir, defaultBranch)
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
      activeTabId: tab.id,
      ...(inheritEditor ? { fileEditorOpenTabIds: new Set([...s.fileEditorOpenTabIds, tab.id]) } : {}),
    }))
    return tabId
  },

  selectTab: (tabId) => {
    const s = get()
    if (tabId === s.activeTabId) {
      // Clicking the already-active tab: toggle global expand/collapse
      const willExpand = !s.isExpanded
      set((prev) => ({
        isExpanded: willExpand,
        marketplaceOpen: false,
        settingsOpen: false,
        // Expanding = reading: clear unread flag
        tabs: willExpand
          ? prev.tabs.map((t) => t.id === tabId ? { ...t, hasUnread: false } : t)
          : prev.tabs,
      }))
    } else {
      // Switching to a different tab: mark as read, auto-expand if setting enabled
      const expandOnSwitch = useThemeStore.getState().expandOnTabSwitch
      set((prev) => ({
        activeTabId: tabId,
        isExpanded: expandOnSwitch ? true : prev.isExpanded,
        marketplaceOpen: false,
        settingsOpen: false,
        tabs: prev.tabs.map((t) =>
          t.id === tabId ? { ...t, hasUnread: false } : t
        ),
      }))
    }
  },

  toggleExpanded: () => {
    const { activeTabId, isExpanded } = get()
    const willExpand = !isExpanded
    set((s) => ({
      isExpanded: willExpand,
      marketplaceOpen: false,
      settingsOpen: false,
      // Expanding = reading: clear unread flag for the active tab
      tabs: willExpand
        ? s.tabs.map((t) => t.id === activeTabId ? { ...t, hasUnread: false } : t)
        : s.tabs,
    }))
  },

  openSettings: () => {
    set({ settingsOpen: true })
  },

  closeSettings: () => {
    set({ settingsOpen: false })
  },

  toggleMarketplace: () => {
    const s = get()
    if (s.marketplaceOpen) {
      set({ marketplaceOpen: false })
    } else {
      set({ isExpanded: false, marketplaceOpen: true })
      get().loadMarketplace()
    }
  },

  closeMarketplace: () => {
    set({ marketplaceOpen: false })
  },

  toggleGitPanel: () => {
    set((s) => ({ gitPanelOpen: !s.gitPanelOpen }))
  },

  toggleTerminal: (tabId) => {
    set((s) => {
      const next = new Set(s.terminalOpenTabIds)
      if (next.has(tabId)) {
        next.delete(tabId)
      } else {
        next.add(tabId)
      }
      return { terminalOpenTabIds: next }
    })
  },

  closeGitPanel: () => {
    set({ gitPanelOpen: false })
  },

  // ─── File Explorer Actions ───

  toggleFileExplorer: (tabId) => {
    set((s) => {
      const next = new Set(s.fileExplorerOpenTabIds)
      if (next.has(tabId)) next.delete(tabId)
      else next.add(tabId)
      return { fileExplorerOpenTabIds: next }
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

  // ─── File Editor Actions ───

  toggleFileEditor: (tabId) => {
    set((s) => {
      const next = new Set(s.fileEditorOpenTabIds)
      if (next.has(tabId)) {
        next.delete(tabId)
        return { fileEditorOpenTabIds: next }
      }
      next.add(tabId)
      // Bring editor to front when toggling on
      set({ fileEditorFocused: true })
      // If no files open for this tab's directory, create a scratch .md file
      const tab = s.tabs.find((t) => t.id === tabId)
      const dir = tab?.workingDirectory
      if (dir) {
        const current = s.fileEditorStates.get(dir)
        if (!current || current.files.length === 0) {
          const states = new Map(s.fileEditorStates)
          const id = nextEditorFileId()
          const newFile: FileEditorTab = {
            id,
            filePath: null,
            fileName: 'Untitled.md',
            content: '',
            savedContent: '',
            isDirty: false,
            isReadOnly: false,
            isPreview: false,
          }
          states.set(dir, { activeFileId: id, files: [newFile] })
          return { fileEditorOpenTabIds: next, fileEditorStates: states }
        }
      }
      return { fileEditorOpenTabIds: next }
    })
  },

  focusFileEditor: () => set({ fileEditorFocused: true }),
  blurFileEditor: () => set({ fileEditorFocused: false }),

  openFileInEditor: (dir, tabId, filePath) => {
    const { closeExplorerOnFileOpen, openMarkdownInPreview } = useThemeStore.getState()
    set((s) => {
      const states = new Map(s.fileEditorStates)
      const current = states.get(dir) || { activeFileId: null, files: [] }
      // If file is already open, just activate it
      const existing = current.files.find((f) => f.filePath === filePath)
      if (existing) {
        states.set(dir, { ...current, activeFileId: existing.id })
      } else {
        const fileName = filePath.split('/').pop() || filePath
        const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : ''
        const isMd = ext === '.md'
        const id = nextEditorFileId()
        const newFile: FileEditorTab = {
          id,
          filePath,
          fileName,
          content: '',
          savedContent: '',
          isDirty: false,
          isReadOnly: !isEditableByDefault(fileName),
          isPreview: isMd && openMarkdownInPreview,
        }
        states.set(dir, { activeFileId: id, files: [...current.files, newFile] })
      }
      // Also make editor visible for this tab
      const editorOpen = new Set(s.fileEditorOpenTabIds)
      editorOpen.add(tabId)
      // Close explorer if setting enabled
      const result: Record<string, any> = { fileEditorStates: states, fileEditorOpenTabIds: editorOpen }
      if (closeExplorerOnFileOpen) {
        const explorerIds = new Set(s.fileExplorerOpenTabIds)
        explorerIds.delete(tabId)
        result.fileExplorerOpenTabIds = explorerIds
      }
      return result
    })
  },

  closeFileEditorTab: (dir, fileId) => {
    set((s) => {
      const states = new Map(s.fileEditorStates)
      const current = states.get(dir)
      if (!current) return {}
      const files = current.files.filter((f) => f.id !== fileId)
      let activeFileId = current.activeFileId
      if (activeFileId === fileId) {
        activeFileId = files.length > 0 ? files[files.length - 1].id : null
      }
      states.set(dir, { activeFileId, files })
      // If last file closed, also close the editor panel for all tabs sharing this dir
      if (files.length === 0) {
        const editorOpen = new Set(s.fileEditorOpenTabIds)
        for (const tab of s.tabs) {
          if (tab.workingDirectory === dir) editorOpen.delete(tab.id)
        }
        return { fileEditorStates: states, fileEditorOpenTabIds: editorOpen }
      }
      return { fileEditorStates: states }
    })
  },

  setActiveEditorFile: (dir, fileId) => {
    set((s) => {
      const states = new Map(s.fileEditorStates)
      const current = states.get(dir)
      if (!current) return {}
      states.set(dir, { ...current, activeFileId: fileId })
      return { fileEditorStates: states }
    })
  },

  createScratchFile: (dir) => {
    set((s) => {
      const states = new Map(s.fileEditorStates)
      const current = states.get(dir) || { activeFileId: null, files: [] }
      const id = nextEditorFileId()
      const newFile: FileEditorTab = {
        id,
        filePath: null,
        fileName: 'Untitled',
        content: '',
        savedContent: '',
        isDirty: false,
        isReadOnly: false,
        isPreview: false,
      }
      states.set(dir, { activeFileId: id, files: [...current.files, newFile] })
      return { fileEditorStates: states }
    })
  },

  updateEditorContent: (dir, fileId, content) => {
    set((s) => {
      const states = new Map(s.fileEditorStates)
      const current = states.get(dir)
      if (!current) return {}
      states.set(dir, {
        ...current,
        files: current.files.map((f) =>
          f.id === fileId ? { ...f, content, isDirty: content !== f.savedContent } : f
        ),
      })
      return { fileEditorStates: states }
    })
  },

  markEditorSaved: (dir, fileId, filePath) => {
    set((s) => {
      const states = new Map(s.fileEditorStates)
      const current = states.get(dir)
      if (!current) return {}
      states.set(dir, {
        ...current,
        files: current.files.map((f) =>
          f.id === fileId
            ? { ...f, filePath, fileName: filePath.split('/').pop() || filePath, savedContent: f.content, isDirty: false }
            : f
        ),
      })
      return { fileEditorStates: states }
    })
  },

  reorderEditorFiles: (dir, reordered) => {
    set((s) => {
      const states = new Map(s.fileEditorStates)
      const current = states.get(dir)
      if (!current) return {}
      states.set(dir, { ...current, files: reordered })
      return { fileEditorStates: states }
    })
  },

  toggleEditorPreview: (dir, fileId) => {
    set((s) => {
      const states = new Map(s.fileEditorStates)
      const current = states.get(dir)
      if (!current) return {}
      states.set(dir, {
        ...current,
        files: current.files.map((f) =>
          f.id === fileId ? { ...f, isPreview: !f.isPreview } : f
        ),
      })
      return { fileEditorStates: states }
    })
  },

  toggleEditorReadOnly: (dir, fileId) => {
    set((s) => {
      const states = new Map(s.fileEditorStates)
      const current = states.get(dir)
      if (!current) return {}
      states.set(dir, {
        ...current,
        files: current.files.map((f) =>
          f.id === fileId ? { ...f, isReadOnly: !f.isReadOnly } : f
        ),
      })
      return { fileEditorStates: states }
    })
  },

  setEditorGeometry: (geo) => set({ editorGeometry: geo }),
  setPlanGeometry: (geo) => set({ planGeometry: geo }),

  loadMarketplace: async (forceRefresh) => {
    set({ marketplaceLoading: true, marketplaceError: null })
    try {
      const [catalog, installed] = await Promise.all([
        window.coda.fetchMarketplace(forceRefresh),
        window.coda.listInstalledPlugins(),
      ])
      if (catalog.error && catalog.plugins.length === 0) {
        set({ marketplaceError: catalog.error, marketplaceLoading: false })
        return
      }
      const installedSet = new Set(installed.map((n) => n.toLowerCase()))
      const pluginStates: Record<string, PluginStatus> = {}
      for (const p of catalog.plugins) {
        // For SKILL.md skills: match individual name against ~/.claude/skills/ dirs
        // For CLI plugins: match installName or "installName@marketplace" against installed_plugins.json
        const candidates = p.isSkillMd
          ? [p.installName]
          : [p.installName, `${p.installName}@${p.marketplace}`]
        const isInstalled = candidates.some((c) => installedSet.has(c.toLowerCase()))
        pluginStates[p.id] = isInstalled ? 'installed' : 'not_installed'
      }
      set({
        marketplaceCatalog: catalog.plugins,
        marketplaceInstalledNames: installed,
        marketplacePluginStates: pluginStates,
        marketplaceLoading: false,
      })
    } catch (err: unknown) {
      set({
        marketplaceError: err instanceof Error ? err.message : String(err),
        marketplaceLoading: false,
      })
    }
  },

  setMarketplaceSearch: (query) => {
    set({ marketplaceSearch: query })
  },

  setMarketplaceFilter: (filter) => {
    set({ marketplaceFilter: filter })
  },

  installMarketplacePlugin: async (plugin) => {
    set((s) => ({
      marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'installing' },
    }))
    const result = await window.coda.installPlugin(plugin.repo, plugin.installName, plugin.marketplace, plugin.sourcePath, plugin.isSkillMd)
    if (result.ok) {
      set((s) => ({
        marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'installed' as PluginStatus },
        marketplaceInstalledNames: [...s.marketplaceInstalledNames, plugin.installName],
      }))
    } else {
      set((s) => ({
        marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'failed' },
      }))
    }
  },

  uninstallMarketplacePlugin: async (plugin) => {
    const result = await window.coda.uninstallPlugin(plugin.installName)
    if (result.ok) {
      set((s) => ({
        marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'not_installed' as PluginStatus },
        marketplaceInstalledNames: s.marketplaceInstalledNames.filter((n) => n !== plugin.installName),
      }))
    }
  },

  buildYourOwn: () => {
    set({ marketplaceOpen: false, settingsOpen: false, isExpanded: true })
    // Small delay to let the UI transition
    setTimeout(() => {
      get().sendMessage('Help me create a new Claude Code skill')
    }, 100)
  },

  closeTab: (tabId) => {
    // Clean up worktree if this tab has one
    const closingTab = get().tabs.find((t) => t.id === tabId)
    if (closingTab?.worktree) {
      window.coda.gitWorktreeRemove(
        closingTab.worktree.repoPath,
        closingTab.worktree.worktreePath,
        closingTab.worktree.branchName,
        true, // force
      ).catch(() => {})
    }
    window.coda.closeTab(tabId).catch(() => {})
    window.coda.terminalDestroy(tabId).catch(() => {})
    destroyTerminalInstance(tabId)
    // Clean up terminal UI state
    const termIds = get().terminalOpenTabIds
    if (termIds.has(tabId)) {
      const next = new Set(termIds)
      next.delete(tabId)
      set({ terminalOpenTabIds: next })
    }
    // Clean up file explorer/editor visibility
    const explorerIds = get().fileExplorerOpenTabIds
    if (explorerIds.has(tabId)) {
      const next = new Set(explorerIds)
      next.delete(tabId)
      set({ fileExplorerOpenTabIds: next })
    }
    const editorIds = get().fileEditorOpenTabIds
    if (editorIds.has(tabId)) {
      const next = new Set(editorIds)
      next.delete(tabId)
      set({ fileEditorOpenTabIds: next })
    }

    const s = get()
    const remaining = s.tabs.filter((t) => t.id !== tabId)

    if (s.activeTabId === tabId) {
      if (remaining.length === 0) {
        const homeDir = get().staticInfo?.homePath || '~'
        const defaultBase = useThemeStore.getState().defaultBaseDirectory
        const startDir = defaultBase || homeDir
        const newTab = makeLocalTab()
        newTab.workingDirectory = startDir
        newTab.hasChosenDirectory = !!defaultBase
        set({ tabs: [newTab], activeTabId: newTab.id, gitPanelOpen: false })
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
  },

  setTabPillColor: (tabId, color) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, pillColor: color } : t
      ),
    }))
  },

  clearTab: () => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, messages: [], lastResult: null, currentActivity: '', permissionQueue: [], permissionDenied: null, queuedPrompts: [] }
          : t
      ),
    }))
  },

  resumeSession: async (sessionId, title, projectPath) => {
    const defaultDir = projectPath || get().staticInfo?.homePath || '~'
    try {
      const { tabId } = await window.coda.createTab()

      // Load previous conversation messages from the JSONL file
      const history = await window.coda.loadSession(sessionId, defaultDir).catch(() => [])
      const messages: Message[] = history.map((m) => ({
        id: nextMsgId(),
        role: m.role as Message['role'],
        content: m.content,
        toolName: m.toolName,
        toolId: m.toolId,
        toolInput: m.toolInput,
        toolStatus: m.toolName ? 'completed' as const : undefined,
        userExecuted: m.userExecuted,
        attachments: m.attachments,
        timestamp: m.timestamp,
      }))

      // Restore plan-ready state if last tool message was ExitPlanMode
      const lastToolMsg = [...messages].reverse().find((m) => m.toolName)
      const restoredDenied = lastToolMsg?.toolName === 'ExitPlanMode'
        ? { tools: [{ toolName: 'ExitPlanMode', toolUseId: 'restored' }] }
        : null

      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        claudeSessionId: sessionId,
        title: title || 'Resumed Session',
        workingDirectory: defaultDir,
        hasChosenDirectory: !!projectPath,
        messages,
        permissionDenied: restoredDenied,
      }
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        isExpanded: true,
      }))
      // Don't call initSession — the first real prompt will use --resume with the sessionId
      return tabId
    } catch {
      const tab = makeLocalTab()
      tab.claudeSessionId = sessionId
      tab.title = title || 'Resumed Session'
      tab.workingDirectory = defaultDir
      tab.hasChosenDirectory = !!projectPath
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        isExpanded: true,
      }))
      return tab.id
    }
  },

  addSystemMessage: (content) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              messages: [
                ...t.messages,
                { id: nextMsgId(), role: 'system' as const, content, timestamp: Date.now() },
              ],
            }
          : t
      ),
    }))
  },

  startBashCommand: (command, execId) => {
    const { activeTabId } = get()
    const toolMsgId = nextMsgId()
    const now = Date.now()
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== activeTabId) return t
        const needsTitle = t.title === 'New Tab' || t.title === 'Resumed Session'
        const title = needsTitle
          ? (command.length > 30 ? command.substring(0, 27) + '...' : command)
          : t.title
        return {
          ...t,
          title,
          bashExecuting: true,
          bashExecId: execId,
          messages: [
            ...t.messages,
            { id: nextMsgId(), role: 'user' as const, content: `! ${command}`, userExecuted: true, timestamp: now },
            { id: toolMsgId, role: 'tool' as const, content: '', toolName: 'Bash', toolInput: JSON.stringify({ command }), toolStatus: 'running' as const, userExecuted: true, timestamp: now },
          ],
        }
      }),
    }))
    return { toolMsgId, tabId: activeTabId }
  },

  completeBashCommand: (tabId, toolMsgId, command, stdout, stderr, exitCode) => {
    const { activeTabId, isExpanded } = get()
    const outputParts: string[] = []
    if (stdout) outputParts.push(stdout.trimEnd())
    if (stderr) outputParts.push(`stderr: ${stderr.trimEnd()}`)
    if (exitCode !== null && exitCode !== 0) outputParts.push(`exit code: ${exitCode}`)
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        return {
          ...t,
          bashExecuting: false,
          bashExecId: null,
          hasUnread: (t.id !== activeTabId || !isExpanded) ? true : t.hasUnread,
          bashResults: [...t.bashResults, { command, stdout, stderr }],
          messages: t.messages.map((m) =>
            m.id === toolMsgId
              ? { ...m, content: outputParts.join('\n'), toolStatus: 'completed' as const }
              : m
          ),
        }
      }),
    }))
    playNotificationIfHidden()
  },

  // ─── Permission response ───

  respondPermission: (tabId, questionId, optionId) => {
    // Send to backend
    window.coda.respondPermission(tabId, questionId, optionId).catch(() => {})

    // Remove answered item from queue; show next tool's activity or clear
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const remaining = t.permissionQueue.filter((p) => p.questionId !== questionId)
        return {
          ...t,
          permissionQueue: remaining,
          currentActivity: remaining.length > 0
            ? `Waiting for permission: ${remaining[0].toolTitle}`
            : 'Working...',
        }
      }),
    }))
  },

  // ─── Directory management ───

  addDirectory: (dir) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              additionalDirs: t.additionalDirs.includes(dir)
                ? t.additionalDirs
                : [...t.additionalDirs, dir],
            }
          : t
      ),
    }))
  },

  removeDirectory: (dir) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, additionalDirs: t.additionalDirs.filter((d) => d !== dir) }
          : t
      ),
    }))
  },

  setBaseDirectory: (dir) => {
    useThemeStore.getState().addRecentBaseDirectory(dir)
    const { activeTabId } = get()
    const tab = get().tabs.find((t) => t.id === activeTabId)

    // If tab has a worktree and no messages yet, clean it up before switching
    if (tab?.worktree && tab.messages.length === 0) {
      window.coda.gitWorktreeRemove(
        tab.worktree.repoPath,
        tab.worktree.worktreePath,
        tab.worktree.branchName,
        true,
      ).catch(() => {})
    }

    window.coda.resetTabSession(activeTabId)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              workingDirectory: dir,
              hasChosenDirectory: true,
              claudeSessionId: null,
              additionalDirs: [],
              worktree: null,
              pendingWorktreeSetup: false,
            }
          : t
      ),
    }))

    // If in worktree mode, re-setup for new directory
    const gitOpsMode = useThemeStore.getState().gitOpsMode
    if (gitOpsMode === 'worktree') {
      window.coda.gitIsRepo(dir).then(({ isRepo }) => {
        if (!isRepo) return
        const defaults = useThemeStore.getState().worktreeBranchDefaults
        const defaultBranch = defaults[dir]
        if (defaultBranch) {
          window.coda.gitWorktreeAdd(dir, defaultBranch).then((result) => {
            if (result.ok && result.worktree) {
              set((s) => ({
                tabs: s.tabs.map((t) =>
                  t.id === activeTabId
                    ? { ...t, worktree: result.worktree!, workingDirectory: result.worktree!.worktreePath }
                    : t
                ),
              }))
            }
          })
        } else {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === activeTabId ? { ...t, pendingWorktreeSetup: true } : t
            ),
          }))
        }
      })
    }
  },

  setupWorktree: async (tabId, sourceBranch, setAsDefault) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    const repoPath = tab.workingDirectory

    if (setAsDefault) {
      useThemeStore.getState().setWorktreeBranchDefault(repoPath, sourceBranch)
    }

    const result = await window.coda.gitWorktreeAdd(repoPath, sourceBranch)
    if (result.ok && result.worktree) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                worktree: result.worktree!,
                workingDirectory: result.worktree!.worktreePath,
                pendingWorktreeSetup: false,
              }
            : t
        ),
      }))
    }
  },

  cancelWorktreeSetup: (tabId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, pendingWorktreeSetup: false } : t
      ),
    }))
  },

  finishWorktreeTab: async (tabId, strategyOverride) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.worktree) return

    const strategy = strategyOverride || useThemeStore.getState().worktreeCompletionStrategy
    const { repoPath, worktreePath, branchName, sourceBranch } = tab.worktree

    if (strategy === 'merge') {
      const result = await window.coda.gitWorktreeMerge(repoPath, branchName, sourceBranch)
      if (!result.ok) {
        // Show error in conversation
        const msg = result.hasConflicts
          ? `Merge conflict: resolve manually in ${repoPath} then close this tab.`
          : `Merge failed: ${result.error}`
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? { ...t, messages: [...t.messages, { id: `msg-${++msgCounter}`, role: 'system' as const, content: msg, timestamp: Date.now() }] }
              : t
          ),
        }))
        return
      }
      // Clean up worktree and close
      await window.coda.gitWorktreeRemove(repoPath, worktreePath, branchName, true).catch(() => {})
      get().closeTab(tabId)
    } else {
      // PR strategy
      const pushResult = await window.coda.gitWorktreePush(worktreePath, sourceBranch)
      if (!pushResult.ok) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? { ...t, messages: [...t.messages, { id: `msg-${++msgCounter}`, role: 'system' as const, content: `Push failed: ${pushResult.error}`, timestamp: Date.now() }] }
              : t
          ),
        }))
        return
      }
      // Open PR URL in browser if we have a remote URL
      if (pushResult.remoteUrl && pushResult.remoteBranch) {
        // Construct GitHub/GitLab PR URL
        const url = pushResult.remoteUrl
          .replace(/\.git$/, '')
          .replace(/^git@([^:]+):/, 'https://$1/')
        window.coda.openExternal(`${url}/compare/${sourceBranch}...${pushResult.remoteBranch}`)
      }
      // Clean up worktree and close
      await window.coda.gitWorktreeRemove(repoPath, worktreePath, branchName, true).catch(() => {})
      get().closeTab(tabId)
    }
  },

  // ─── Attachment management ───

  addAttachments: (attachments) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, attachments: [...t.attachments, ...attachments] }
          : t
      ),
    }))
  },

  removeAttachment: (attachmentId) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, attachments: t.attachments.filter((a) => a.id !== attachmentId) }
          : t
      ),
    }))
  },

  clearAttachments: () => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId ? { ...t, attachments: [] } : t
      ),
    }))
  },

  setDraftInput: (tabId, text) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, draftInput: text } : t
      ),
    }))
  },

  // ─── Send ───

  sendMessage: (prompt, projectPath, extraAttachments) => {
    const { activeTabId, tabs, staticInfo } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    // Use explicitly chosen directory, otherwise fall back to user home
    const resolvedPath = projectPath || (tab?.hasChosenDirectory ? tab.workingDirectory : (staticInfo?.homePath || tab?.workingDirectory || '~'))
    if (!tab) return

    // Guard: don't send while connecting (warmup in progress)
    if (tab.status === 'connecting') return

    // Slash commands are action-oriented -- auto-switch out of plan mode
    // so the command can execute tools without manual approval
    if (!tab.claudeSessionId && tab.permissionMode === 'plan' && prompt.startsWith('/')) {
      get().setPermissionMode('auto')
    }

    const isBusy = tab.status === 'running'
    const requestId = crypto.randomUUID()

    // Combine file attachments from tab with any extra attachments (e.g. plan)
    const msgAttachments: Attachment[] = [
      ...tab.attachments,
      ...(extraAttachments || []),
    ]

    // Build full prompt with bash results and attachment context
    let fullPrompt = prompt
    if (tab.bashResults.length > 0) {
      const bashCtx = tab.bashResults.map((b) => {
        const parts = [`$ ${b.command}`]
        if (b.stdout) parts.push('```\n' + b.stdout.trimEnd() + '\n```')
        if (b.stderr) parts.push('stderr:\n```\n' + b.stderr.trimEnd() + '\n```')
        return parts.join('\n')
      }).join('\n\n')
      fullPrompt = bashCtx + '\n\n' + fullPrompt
    }
    if (tab.attachments.length > 0) {
      const attachmentCtx = tab.attachments
        .map((a) => `[Attached ${a.type}: ${a.path}]`)
        .join('\n')
      fullPrompt = `${attachmentCtx}\n\n${fullPrompt}`
    }

    const needsTitle = tab.title === 'New Tab' || tab.title === 'Resumed Session'
    const title = needsTitle
      ? (prompt.length > 30 ? prompt.substring(0, 27) + '...' : prompt)
      : tab.title

    // Optimistic update: clear attachments
    // If busy, add to queuedPrompts (shown at bottom); otherwise add to messages and set connecting
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== activeTabId) return t
        const withEffectiveBase = t.hasChosenDirectory
          ? t
          : {
              ...t,
              // Once the user sends the first message, lock in the effective
              // base directory (home by default) so the footer no longer shows "—".
              hasChosenDirectory: true,
              workingDirectory: resolvedPath,
            }
        if (isBusy) {
          return {
            ...withEffectiveBase,
            title,
            attachments: [],
            bashResults: [],
            queuedPrompts: [...withEffectiveBase.queuedPrompts, prompt],
          }
        }
        return {
          ...withEffectiveBase,
          status: 'connecting' as TabStatus,
          activeRequestId: requestId,
          currentActivity: 'Starting...',
          title,
          attachments: [],
          bashResults: [],
          permissionDenied: null,
          messages: [
            ...withEffectiveBase.messages,
            {
              id: nextMsgId(),
              role: 'user' as const,
              content: prompt,
              attachments: msgAttachments.length > 0 ? msgAttachments : undefined,
              timestamp: Date.now(),
            },
          ],
        }
      }),
    }))

    // Send to backend — ControlPlane will queue if a run is active
    const { preferredModel } = get()
    window.coda.prompt(activeTabId, requestId, {
      prompt: fullPrompt,
      projectPath: resolvedPath,
      sessionId: tab.claudeSessionId || undefined,
      model: preferredModel || undefined,
      addDirs: tab.additionalDirs.length > 0 ? tab.additionalDirs : undefined,
    }).catch((err: Error) => {
      get().handleError(activeTabId, {
        message: err.message,
        stderrTail: [],
        exitCode: null,
        elapsedMs: 0,
        toolCallCount: 0,
      })
    })
  },

  // ─── Event handlers ───

  handleNormalizedEvent: (tabId, event) => {
    set((s) => {
      const { activeTabId } = s
      const tabs = s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab
        const updated = { ...tab }

        switch (event.type) {
          case 'session_init':
            updated.claudeSessionId = event.sessionId
            updated.sessionModel = event.model
            updated.sessionTools = event.tools
            updated.sessionMcpServers = event.mcpServers
            updated.sessionSkills = event.skills
            updated.sessionVersion = event.version
            // Don't change status/activity for warmup inits — they're invisible
            if (!event.isWarmup) {
              updated.status = 'running'
              updated.currentActivity = 'Thinking...'
              // Move the first queued prompt into the timeline (it's now being processed)
              if (updated.queuedPrompts.length > 0) {
                const [nextPrompt, ...rest] = updated.queuedPrompts
                updated.queuedPrompts = rest
                updated.messages = [
                  ...updated.messages,
                  { id: nextMsgId(), role: 'user' as const, content: nextPrompt, timestamp: Date.now() },
                ]
              }
            }
            break

          case 'text_chunk': {
            updated.currentActivity = 'Writing...'
            const lastMsg = updated.messages[updated.messages.length - 1]
            if (lastMsg?.role === 'assistant' && !lastMsg.toolName) {
              updated.messages = [
                ...updated.messages.slice(0, -1),
                { ...lastMsg, content: lastMsg.content + event.text },
              ]
            } else {
              updated.messages = [
                ...updated.messages,
                { id: nextMsgId(), role: 'assistant', content: event.text, timestamp: Date.now() },
              ]
            }
            break
          }

          case 'tool_call':
            updated.currentActivity = `Running ${event.toolName}...`
            updated.messages = [
              ...updated.messages,
              {
                id: nextMsgId(),
                role: 'tool',
                content: '',
                toolName: event.toolName,
                toolId: event.toolId,
                toolInput: '',
                toolStatus: 'running',
                timestamp: Date.now(),
              },
            ]
            break

          case 'tool_call_update': {
            const msgs = [...updated.messages]
            const lastTool = [...msgs].reverse().find((m) => m.role === 'tool' && m.toolStatus === 'running')
            if (lastTool) {
              lastTool.toolInput = (lastTool.toolInput || '') + event.partialInput
            }
            updated.messages = msgs
            break
          }

          case 'tool_call_complete': {
            const msgs2 = [...updated.messages]
            const runningTool = [...msgs2].reverse().find((m) => m.role === 'tool' && m.toolStatus === 'running')
            if (runningTool) {
              runningTool.toolStatus = 'completed'
            }
            updated.messages = msgs2
            break
          }

          case 'tool_result': {
            const msgs3 = [...updated.messages]
            const targetTool = [...msgs3].reverse().find((m) => m.role === 'tool' && m.toolId === event.toolId)
            if (targetTool) {
              targetTool.content = event.content
              if (event.isError && targetTool.toolName !== 'ExitPlanMode' && targetTool.toolName !== 'AskUserQuestion') {
                targetTool.toolStatus = 'error'
              }
              if (useThemeStore.getState().expandToolResults && ['Write', 'Edit', 'NotebookEdit'].includes(targetTool.toolName || '')) {
                targetTool.autoExpandResult = true
              }
            }
            updated.messages = msgs3
            break
          }

          case 'task_update': {
            // ── Text fallback ──
            // text_chunk events (from stream_event deltas) are the primary render path.
            // If they didn't arrive for this run (timing, partial stream, etc.), the
            // assembled assistant event still has the full text — extract it here.
            // "This run" = everything after the last user message.
            if (event.message?.content) {
              const lastUserIdx = (() => {
                for (let i = updated.messages.length - 1; i >= 0; i--) {
                  if (updated.messages[i].role === 'user') return i
                }
                return -1
              })()
              const hasStreamedText = updated.messages
                .slice(lastUserIdx + 1)
                .some((m) => m.role === 'assistant' && !m.toolName)

              if (!hasStreamedText) {
                const textContent = event.message.content
                  .filter((b) => b.type === 'text' && b.text)
                  .map((b) => b.text!)
                  .join('')
                if (textContent) {
                  updated.messages = [
                    ...updated.messages,
                    { id: nextMsgId(), role: 'assistant' as const, content: textContent, timestamp: Date.now() },
                  ]
                }
              }

              // ── Tool card deduplication (unchanged) ──
              for (const block of event.message.content) {
                if (block.type === 'tool_use' && block.name) {
                  const exists = updated.messages.find(
                    (m) => m.role === 'tool' && m.toolName === block.name && !m.content
                  )
                  if (!exists) {
                    updated.messages = [
                      ...updated.messages,
                      {
                        id: nextMsgId(),
                        role: 'tool',
                        content: '',
                        toolName: block.name,
                        toolInput: JSON.stringify(block.input, null, 2),
                        toolStatus: 'completed',
                        timestamp: Date.now(),
                      },
                    ]
                  } else if (block.input) {
                    // Ensure toolInput has complete data from the assembled assistant message
                    // (streaming tool_call_update events may have been incomplete)
                    const completeInput = JSON.stringify(block.input, null, 2)
                    if (exists.toolInput !== completeInput) {
                      updated.messages = updated.messages.map((m) =>
                        m === exists ? { ...m, toolInput: completeInput } : m
                      )
                    }
                  }
                }
              }
            }
            break
          }

          case 'task_complete':
            updated.status = 'completed'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.lastResult = {
              totalCostUsd: event.costUsd,
              durationMs: event.durationMs,
              numTurns: event.numTurns,
              usage: event.usage,
              sessionId: event.sessionId,
            }
            // ── Final text fallback ──
            // If neither text_chunks nor task_update text produced an assistant message,
            // use event.result (the CLI's assembled final output) as last resort.
            if (event.result) {
              const lastUserIdx2 = (() => {
                for (let i = updated.messages.length - 1; i >= 0; i--) {
                  if (updated.messages[i].role === 'user') return i
                }
                return -1
              })()
              const hasAnyText = updated.messages
                .slice(lastUserIdx2 + 1)
                .some((m) => m.role === 'assistant' && !m.toolName)
              if (!hasAnyText) {
                updated.messages = [
                  ...updated.messages,
                  { id: nextMsgId(), role: 'assistant' as const, content: event.result, timestamp: Date.now() },
                ]
              }
            }
            // Mark as unread unless the user is actively viewing this tab
            // (active tab with card expanded). A collapsed active tab still
            // counts as "unread" — the user hasn't seen the response yet.
            if (tabId !== activeTabId || !s.isExpanded) {
              updated.hasUnread = true
            }
            // Show fallback card when tools were denied by permission settings.
            // Filter out ExitPlanMode denials when not in plan mode — the model
            // may call ExitPlanMode from conversation-history patterns even after
            // the user exited plan mode (known Claude Code bug).
            if (event.permissionDenials && event.permissionDenials.length > 0) {
              const denials = updated.permissionMode === 'plan'
                ? event.permissionDenials
                : event.permissionDenials.filter((d) => d.toolName !== 'ExitPlanMode')
              updated.permissionDenied = denials.length > 0 ? { tools: denials } : null
            } else {
              updated.permissionDenied = null
            }
            // Play notification sound if window is hidden
            playNotificationIfHidden()
            break

          case 'error':
            updated.status = 'failed'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.permissionDenied = null
            updated.messages = [
              ...updated.messages,
              { id: nextMsgId(), role: 'system', content: `Error: ${event.message}`, timestamp: Date.now() },
            ]
            break

          case 'session_dead':
            updated.status = 'dead'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.permissionDenied = null
            updated.messages = [
              ...updated.messages,
              {
                id: nextMsgId(),
                role: 'system',
                content: `Session ended unexpectedly (exit ${event.exitCode})`,
                timestamp: Date.now(),
              },
            ]
            break

          case 'permission_request': {
            const newReq: import('../../shared/types').PermissionRequest = {
              questionId: event.questionId,
              toolTitle: event.toolName,
              toolDescription: event.toolDescription,
              toolInput: event.toolInput,
              options: event.options.map((o) => ({
                optionId: o.id,
                kind: o.kind,
                label: o.label,
              })),
            }
            updated.permissionQueue = [...updated.permissionQueue, newReq]
            updated.currentActivity = `Waiting for permission: ${event.toolName}`
            break
          }

          case 'rate_limit':
            if (event.status !== 'allowed') {
              updated.messages = [
                ...updated.messages,
                {
                  id: nextMsgId(),
                  role: 'system',
                  content: `Rate limited (${event.rateLimitType}). Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.`,
                  timestamp: Date.now(),
                },
              ]
            }
            break
        }

        return updated
      })

      return { tabs }
    })
  },

  handleStatusChange: (tabId, newStatus) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              status: newStatus as TabStatus,
              // Clear activity when transitioning to idle (e.g., after warmup init)
              ...(newStatus === 'idle' ? { currentActivity: '', permissionQueue: [] as import('../../shared/types').PermissionRequest[], permissionDenied: null } : {}),
            }
          : t
      ),
    }))
  },

  handleError: (tabId, error) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t

        // Deduplicate: skip if the last message is already an error for this failure
        const lastMsg = t.messages[t.messages.length - 1]
        const alreadyHasError = lastMsg?.role === 'system' && lastMsg.content.startsWith('Error:')

        return {
          ...t,
          status: 'failed' as TabStatus,
          activeRequestId: null,
          currentActivity: '',
          permissionQueue: [],
          messages: alreadyHasError
            ? t.messages
            : [
                ...t.messages,
                {
                  id: nextMsgId(),
                  role: 'system' as const,
                  content: `Error: ${error.message}${error.stderrTail.length > 0 ? '\n\n' + error.stderrTail.slice(-5).join('\n') : ''}`,
                  timestamp: Date.now(),
                },
              ],
        }
      }),
    }))
  },
}))

// ─── Real-time tab persistence ───

function persistTabs(): void {
  const { tabs, activeTabId } = useSessionStore.getState()
  const activeTab = tabs.find((t) => t.id === activeTabId)
  // Persist tabs with a session OR tabs that have editor state for their directory
  const dirsWithEditorState = new Set<string>()
  for (const [dir, dirState] of useSessionStore.getState().fileEditorStates) {
    if (dirState.files.length > 0) dirsWithEditorState.add(dir)
  }

  const persistedTabs = tabs
    .filter((t) => t.claudeSessionId || (t.hasChosenDirectory && dirsWithEditorState.has(t.workingDirectory)))
    .map((t) => ({
      claudeSessionId: t.claudeSessionId,
      title: t.customTitle || t.title,
      customTitle: t.customTitle,
      workingDirectory: t.workingDirectory,
      hasChosenDirectory: t.hasChosenDirectory,
      additionalDirs: t.additionalDirs,
      permissionMode: t.permissionMode,
      ...(t.bashResults.length > 0 ? { bashResults: t.bashResults } : {}),
      ...(t.pillColor ? { pillColor: t.pillColor } : {}),
      ...(t.worktree ? { worktree: t.worktree } : {}),
    }))

  // Serialize editor states (per-directory, includes unsaved content)
  const { fileEditorStates } = useSessionStore.getState()
  const editorStates: Record<string, any> = {}
  for (const [dir, dirState] of fileEditorStates) {
    if (dirState.files.length > 0) {
      const activeIdx = dirState.activeFileId
        ? dirState.files.findIndex((f) => f.id === dirState.activeFileId)
        : -1
      editorStates[dir] = {
        activeFileIndex: activeIdx >= 0 ? activeIdx : 0,
        files: dirState.files.map((f) => ({
          filePath: f.filePath,
          fileName: f.fileName,
          content: f.content,
          savedContent: f.savedContent,
          isDirty: f.isDirty,
          isReadOnly: f.isReadOnly,
          isPreview: f.isPreview,
        })),
      }
    }
  }

  // Resolve which persisted tabs have the editor open (by index into persistedTabs)
  const { isExpanded, fileEditorOpenTabIds, editorGeometry, planGeometry } = useSessionStore.getState()
  const editorOpenIndices: number[] = []
  // Build a lookup from tab id -> persisted index
  let persistedIdx = 0
  for (const t of tabs) {
    const isPersisted = t.claudeSessionId || (t.hasChosenDirectory && dirsWithEditorState.has(t.workingDirectory))
    if (isPersisted) {
      if (fileEditorOpenTabIds.has(t.id)) {
        editorOpenIndices.push(persistedIdx)
      }
      persistedIdx++
    }
  }

  // Resolve active tab as index into persistedTabs (handles sessionless tabs)
  let activeTabIndex: number | null = null
  persistedIdx = 0
  for (const t of tabs) {
    const isPersisted = t.claudeSessionId || (t.hasChosenDirectory && dirsWithEditorState.has(t.workingDirectory))
    if (isPersisted) {
      if (t.id === activeTabId) activeTabIndex = persistedIdx
      persistedIdx++
    }
  }

  const data: PersistedTabState = {
    activeSessionId: activeTab?.claudeSessionId || null,
    activeTabIndex,
    tabs: persistedTabs,
    editorStates: Object.keys(editorStates).length > 0 ? editorStates : undefined,
    isExpanded,
    editorOpenSessionIds: editorOpenIndices.length > 0 ? editorOpenIndices : undefined,
    editorGeometry,
    planGeometry,
  }
  window.coda.saveTabs(data)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
useSessionStore.subscribe((state, prev) => {
  if (state.tabs !== prev.tabs || state.activeTabId !== prev.activeTabId || state.fileEditorStates !== prev.fileEditorStates || state.isExpanded !== prev.isExpanded || state.fileEditorOpenTabIds !== prev.fileEditorOpenTabIds || state.editorGeometry !== prev.editorGeometry || state.planGeometry !== prev.planGeometry) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(persistTabs, 100)
  }
})

// Close terminal, explorer, and git panel when conversation collapses
useSessionStore.subscribe((state, prev) => {
  if (prev.isExpanded && !state.isExpanded) {
    const { activeTabId, terminalOpenTabIds, fileExplorerOpenTabIds } = state
    const updates: Record<string, any> = {}
    if (terminalOpenTabIds.has(activeTabId)) {
      const next = new Set(terminalOpenTabIds)
      next.delete(activeTabId)
      updates.terminalOpenTabIds = next
    }
    if (fileExplorerOpenTabIds.has(activeTabId)) {
      const next = new Set(fileExplorerOpenTabIds)
      next.delete(activeTabId)
      updates.fileExplorerOpenTabIds = next
    }
    if (state.gitPanelOpen) {
      updates.gitPanelOpen = false
    }
    if (Object.keys(updates).length > 0) {
      useSessionStore.setState(updates)
    }
  }
})
