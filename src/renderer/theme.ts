/**
 * CODA Design Tokens — Dual theme (dark + light)
 * Colors derived from ChatCN oklch system and design-fixed.html reference.
 */
import { create } from 'zustand'
import type { GitOpsMode, WorktreeCompletionStrategy, TabGroupMode, TabGroup } from '../shared/types'
import { DEFAULT_TAB_GROUP_LABELS } from '../shared/types'

// ─── Color palettes ───

const darkColors = {
  // Container (glass surfaces)
  containerBg: '#242422',
  containerBgCollapsed: '#21211e',
  containerBorder: '#3b3b36',
  containerShadow: '0 8px 28px rgba(0, 0, 0, 0.35), 0 1px 6px rgba(0, 0, 0, 0.25)',
  cardShadow: '0 2px 8px rgba(0,0,0,0.35)',
  cardShadowCollapsed: '0 2px 6px rgba(0,0,0,0.4)',

  // Surface layers
  surfacePrimary: '#353530',
  surfaceSecondary: '#42423d',
  surfaceHover: 'rgba(255, 255, 255, 0.05)',
  surfaceActive: 'rgba(255, 255, 255, 0.08)',

  // Input
  inputBg: 'transparent',
  inputBorder: '#3b3b36',
  inputFocusBorder: 'rgba(217, 119, 87, 0.4)',
  inputPillBg: '#2a2a27',

  // Text
  textPrimary: '#ccc9c0',
  textSecondary: '#c0bdb2',
  textTertiary: '#76766e',
  textMuted: '#353530',

  // Accent — orange
  accent: '#d97757',
  accentLight: 'rgba(217, 119, 87, 0.1)',
  accentSoft: 'rgba(217, 119, 87, 0.15)',

  // Status dots
  statusIdle: '#8a8a80',
  statusRunning: '#d97757',
  statusRunningBg: 'rgba(217, 119, 87, 0.1)',
  statusComplete: '#7aac8c',
  statusCompleteBg: 'rgba(122, 172, 140, 0.1)',
  statusError: '#c47060',
  statusErrorBg: 'rgba(196, 112, 96, 0.08)',
  statusDead: '#c47060',
  statusBash: '#cc6b9a',
  statusBashGlow: 'rgba(204, 107, 154, 0.4)',
  statusPermission: '#d97757',
  statusPermissionGlow: 'rgba(217, 119, 87, 0.4)',

  // Tab
  tabActive: '#353530',
  tabActiveBorder: '#4a4a45',
  tabInactive: 'transparent',
  tabHover: 'rgba(255, 255, 255, 0.05)',

  // User message bubble
  userBubble: '#353530',
  userBubbleBorder: '#4a4a45',
  userBubbleText: '#ccc9c0',

  // Tool card
  toolBg: '#353530',
  toolBorder: '#4a4a45',
  toolRunningBorder: 'rgba(217, 119, 87, 0.3)',
  toolRunningBg: 'rgba(217, 119, 87, 0.05)',

  // Timeline
  timelineLine: '#353530',
  timelineNode: 'rgba(217, 119, 87, 0.2)',
  timelineNodeActive: '#d97757',

  // Scrollbar
  scrollThumb: 'rgba(255, 255, 255, 0.15)',
  scrollThumbHover: 'rgba(255, 255, 255, 0.25)',

  // Stop button
  stopBg: '#ef4444',
  stopHover: '#dc2626',

  // Send button
  sendBg: '#d97757',
  sendHover: '#c96442',
  sendDisabled: 'rgba(217, 119, 87, 0.3)',

  // Popover
  popoverBg: '#292927',
  popoverBorder: '#3b3b36',
  popoverShadow: '0 4px 20px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2)',

  // Code block
  codeBg: '#1a1a18',

  // Mic button
  micBg: '#353530',
  micColor: '#c0bdb2',
  micDisabled: '#42423d',

  // Placeholder
  placeholder: '#6b6b60',

  // Disabled button color
  btnDisabled: '#42423d',

  // Text on accent backgrounds
  textOnAccent: '#ffffff',

  // Button hover (CSS-only stack buttons)
  btnHoverColor: '#c0bdb2',
  btnHoverBg: '#302f2d',

  // Accent border variants (replaces hex-alpha concatenation antipattern)
  accentBorder: 'rgba(217, 119, 87, 0.19)',
  accentBorderMedium: 'rgba(217, 119, 87, 0.25)',

  // Permission card (amber)
  permissionBorder: 'rgba(245, 158, 11, 0.3)',
  permissionShadow: '0 2px 12px rgba(245, 158, 11, 0.08)',
  permissionHeaderBg: 'rgba(245, 158, 11, 0.06)',
  permissionHeaderBorder: 'rgba(245, 158, 11, 0.12)',

  // Permission allow (green)
  permissionAllowBg: 'rgba(34, 197, 94, 0.1)',
  permissionAllowHoverBg: 'rgba(34, 197, 94, 0.22)',
  permissionAllowBorder: 'rgba(34, 197, 94, 0.25)',

  // Permission deny (red)
  permissionDenyBg: 'rgba(239, 68, 68, 0.08)',
  permissionDenyHoverBg: 'rgba(239, 68, 68, 0.18)',
  permissionDenyBorder: 'rgba(239, 68, 68, 0.22)',

  // Permission denied card
  permissionDeniedBorder: 'rgba(196, 112, 96, 0.3)',
  permissionDeniedHeaderBorder: 'rgba(196, 112, 96, 0.12)',

  // Info / question card (blue)
  infoBg: 'rgba(96, 165, 250, 0.1)',
  infoHoverBg: 'rgba(96, 165, 250, 0.15)',
  infoBorder: 'rgba(96, 165, 250, 0.25)',
  infoText: 'rgba(96, 165, 250, 0.85)',
  infoShadow: 'rgba(96, 165, 250, 0.06)',

  // Tab waiting-state glows
  tabGlowPlanReady: 'rgba(122, 172, 140, 0.5)',
  tabGlowPlanReadyShadow: 'rgba(122, 172, 140, 0.25)',
  tabGlowQuestion: 'rgba(96, 165, 250, 0.5)',
  tabGlowQuestionShadow: 'rgba(96, 165, 250, 0.25)',

  // Diff (inline edit diffs + git diff viewer)
  diffAddBg: 'rgba(122, 172, 140, 0.12)',
  diffAddText: '#7aac8c',
  diffRemoveBg: 'rgba(196, 112, 96, 0.1)',
  diffRemoveText: '#c47060',
} as const

const lightColors = {
  // Container (glass surfaces)
  containerBg: '#f9f8f5',
  containerBgCollapsed: '#f4f2ed',
  containerBorder: '#dddad2',
  containerShadow: '0 8px 28px rgba(0, 0, 0, 0.08), 0 1px 6px rgba(0, 0, 0, 0.04)',
  cardShadow: '0 2px 8px rgba(0,0,0,0.06)',
  cardShadowCollapsed: '0 2px 6px rgba(0,0,0,0.08)',

  // Surface layers
  surfacePrimary: '#edeae0',
  surfaceSecondary: '#dddad2',
  surfaceHover: 'rgba(0, 0, 0, 0.04)',
  surfaceActive: 'rgba(0, 0, 0, 0.06)',

  // Input
  inputBg: 'transparent',
  inputBorder: '#dddad2',
  inputFocusBorder: 'rgba(217, 119, 87, 0.4)',
  inputPillBg: '#ffffff',

  // Text
  textPrimary: '#3c3929',
  textSecondary: '#5a5749',
  textTertiary: '#8a8a80',
  textMuted: '#dddad2',

  // Accent — orange (same)
  accent: '#d97757',
  accentLight: 'rgba(217, 119, 87, 0.1)',
  accentSoft: 'rgba(217, 119, 87, 0.12)',

  // Status dots
  statusIdle: '#8a8a80',
  statusRunning: '#d97757',
  statusRunningBg: 'rgba(217, 119, 87, 0.1)',
  statusComplete: '#5a9e6f',
  statusCompleteBg: 'rgba(90, 158, 111, 0.1)',
  statusError: '#c47060',
  statusErrorBg: 'rgba(196, 112, 96, 0.06)',
  statusDead: '#c47060',
  statusBash: '#cc6b9a',
  statusBashGlow: 'rgba(204, 107, 154, 0.3)',
  statusPermission: '#d97757',
  statusPermissionGlow: 'rgba(217, 119, 87, 0.3)',

  // Tab
  tabActive: '#edeae0',
  tabActiveBorder: '#dddad2',
  tabInactive: 'transparent',
  tabHover: 'rgba(0, 0, 0, 0.04)',

  // User message bubble
  userBubble: '#edeae0',
  userBubbleBorder: '#dddad2',
  userBubbleText: '#3c3929',

  // Tool card
  toolBg: '#edeae0',
  toolBorder: '#dddad2',
  toolRunningBorder: 'rgba(217, 119, 87, 0.3)',
  toolRunningBg: 'rgba(217, 119, 87, 0.05)',

  // Timeline
  timelineLine: '#dddad2',
  timelineNode: 'rgba(217, 119, 87, 0.2)',
  timelineNodeActive: '#d97757',

  // Scrollbar
  scrollThumb: 'rgba(0, 0, 0, 0.1)',
  scrollThumbHover: 'rgba(0, 0, 0, 0.18)',

  // Stop button
  stopBg: '#ef4444',
  stopHover: '#dc2626',

  // Send button
  sendBg: '#d97757',
  sendHover: '#c96442',
  sendDisabled: 'rgba(217, 119, 87, 0.3)',

  // Popover
  popoverBg: '#f9f8f5',
  popoverBorder: '#dddad2',
  popoverShadow: '0 4px 20px rgba(0,0,0,0.1), 0 1px 4px rgba(0,0,0,0.06)',

  // Code block
  codeBg: '#f0eee8',

  // Mic button
  micBg: '#edeae0',
  micColor: '#5a5749',
  micDisabled: '#c8c5bc',

  // Placeholder
  placeholder: '#b0ada4',

  // Disabled button color
  btnDisabled: '#c8c5bc',

  // Text on accent backgrounds
  textOnAccent: '#ffffff',

  // Button hover (CSS-only stack buttons)
  btnHoverColor: '#3c3929',
  btnHoverBg: '#edeae0',

  // Accent border variants (replaces hex-alpha concatenation antipattern)
  accentBorder: 'rgba(217, 119, 87, 0.19)',
  accentBorderMedium: 'rgba(217, 119, 87, 0.25)',

  // Permission card (amber)
  permissionBorder: 'rgba(245, 158, 11, 0.3)',
  permissionShadow: '0 2px 12px rgba(245, 158, 11, 0.08)',
  permissionHeaderBg: 'rgba(245, 158, 11, 0.06)',
  permissionHeaderBorder: 'rgba(245, 158, 11, 0.12)',

  // Permission allow (green)
  permissionAllowBg: 'rgba(34, 197, 94, 0.1)',
  permissionAllowHoverBg: 'rgba(34, 197, 94, 0.22)',
  permissionAllowBorder: 'rgba(34, 197, 94, 0.25)',

  // Permission deny (red)
  permissionDenyBg: 'rgba(239, 68, 68, 0.08)',
  permissionDenyHoverBg: 'rgba(239, 68, 68, 0.18)',
  permissionDenyBorder: 'rgba(239, 68, 68, 0.22)',

  // Permission denied card
  permissionDeniedBorder: 'rgba(196, 112, 96, 0.3)',
  permissionDeniedHeaderBorder: 'rgba(196, 112, 96, 0.12)',

  // Info / question card (blue)
  infoBg: 'rgba(96, 165, 250, 0.08)',
  infoHoverBg: 'rgba(96, 165, 250, 0.12)',
  infoBorder: 'rgba(96, 165, 250, 0.25)',
  infoText: 'rgba(59, 130, 246, 0.9)',
  infoShadow: 'rgba(96, 165, 250, 0.06)',

  // Tab waiting-state glows
  tabGlowPlanReady: 'rgba(90, 158, 111, 0.5)',
  tabGlowPlanReadyShadow: 'rgba(90, 158, 111, 0.2)',
  tabGlowQuestion: 'rgba(59, 130, 246, 0.5)',
  tabGlowQuestionShadow: 'rgba(59, 130, 246, 0.2)',

  // Diff (inline edit diffs + git diff viewer)
  diffAddBg: 'rgba(90, 158, 111, 0.12)',
  diffAddText: '#5a9e6f',
  diffRemoveBg: 'rgba(196, 112, 96, 0.08)',
  diffRemoveText: '#c47060',
} as const

export type ColorPalette = { [K in keyof typeof darkColors]: string }

// ─── Theme store ───

export type ThemeMode = 'system' | 'light' | 'dark'

interface ThemeState {
  isDark: boolean
  themeMode: ThemeMode
  soundEnabled: boolean
  expandedUI: boolean
  ultraWide: boolean
  defaultBaseDirectory: string
  recentBaseDirectories: string[]
  preferredOpenWith: 'cli' | 'vscode'
  showImplementClearContext: boolean
  defaultPermissionMode: 'ask' | 'auto' | 'plan'
  expandOnTabSwitch: boolean
  bashCommandEntry: boolean
  gitPanelSplitRatio: number
  gitPanelChangesOpen: boolean
  gitPanelGraphOpen: boolean
  expandToolResults: boolean
  terminalFontFamily: string
  terminalFontSize: number
  closeExplorerOnFileOpen: boolean
  openMarkdownInPreview: boolean
  editorWordWrap: boolean
  /** Git operations mode: manual (no automation) or worktree (managed per-tab worktrees) */
  gitOpsMode: GitOpsMode
  /** How to complete worktree work: merge --no-ff or push + PR */
  worktreeCompletionStrategy: WorktreeCompletionStrategy
  /** Map of repo path -> default source branch for worktree creation */
  worktreeBranchDefaults: Record<string, string>
  /** Skip the PR title dialog and always use auto-generated branch name */
  worktreeSkipPrTitle: boolean
  /** Show approval card instead of hard failure when agent edits its own settings */
  allowSettingsEdits: boolean
  /** Show the todo/task list panel at the bottom of the conversation */
  showTodoList: boolean
  /** Hide CODA overlay when launching external apps (Finder, Terminal, VS Code, etc.) */
  hideOnExternalLaunch: boolean
  /** Keep explorer open when conversation is minimized */
  keepExplorerOnCollapse: boolean
  /** Keep terminal open when conversation is minimized */
  keepTerminalOnCollapse: boolean
  /** Keep git panel open when conversation is minimized */
  keepGitPanelOnCollapse: boolean
  /** Tab grouping mode: off (flat), auto (by directory), manual (user-defined groups) */
  tabGroupMode: TabGroupMode
  /** Manual/auto tab group definitions */
  tabGroups: TabGroup[]
  /** Persisted ordering for auto-mode groups (directory paths in order) */
  autoGroupOrder: string[]
  /** Group ID that tabs auto-move into when implementation starts (null = disabled) */
  inProgressGroupId: string | null
  /** Group ID that tabs move into after committing (null = disabled) */
  doneGroupId: string | null
  /** Custom bash command to run instead of prompting the LLM for commits */
  commitCommand: string
  /** Custom command to launch Claude in the terminal (default: 'claude') */
  claudeCommand: string
  /** OS-reported dark mode — used when themeMode is 'system' */
  _systemIsDark: boolean
  setIsDark: (isDark: boolean) => void
  setThemeMode: (mode: ThemeMode) => void
  setSoundEnabled: (enabled: boolean) => void
  setExpandedUI: (expanded: boolean) => void
  setUltraWide: (enabled: boolean) => void
  setDefaultBaseDirectory: (dir: string) => void
  addRecentBaseDirectory: (dir: string) => void
  removeRecentBaseDirectory: (dir: string) => void
  setPreferredOpenWith: (app: 'cli' | 'vscode') => void
  setShowImplementClearContext: (show: boolean) => void
  setDefaultPermissionMode: (mode: 'ask' | 'auto' | 'plan') => void
  setExpandOnTabSwitch: (enabled: boolean) => void
  setBashCommandEntry: (enabled: boolean) => void
  setGitPanelSplitRatio: (ratio: number) => void
  setGitPanelChangesOpen: (open: boolean) => void
  setGitPanelGraphOpen: (open: boolean) => void
  setExpandToolResults: (enabled: boolean) => void
  setTerminalFontFamily: (font: string) => void
  setTerminalFontSize: (size: number) => void
  setCloseExplorerOnFileOpen: (enabled: boolean) => void
  setOpenMarkdownInPreview: (enabled: boolean) => void
  setEditorWordWrap: (enabled: boolean) => void
  setGitOpsMode: (mode: GitOpsMode) => void
  setWorktreeCompletionStrategy: (strategy: WorktreeCompletionStrategy) => void
  setWorktreeBranchDefault: (repoPath: string, branch: string) => void
  removeWorktreeBranchDefault: (repoPath: string) => void
  setWorktreeSkipPrTitle: (skip: boolean) => void
  setAllowSettingsEdits: (enabled: boolean) => void
  setShowTodoList: (enabled: boolean) => void
  setHideOnExternalLaunch: (enabled: boolean) => void
  setKeepExplorerOnCollapse: (enabled: boolean) => void
  setKeepTerminalOnCollapse: (enabled: boolean) => void
  setKeepGitPanelOnCollapse: (enabled: boolean) => void
  setTabGroupMode: (mode: TabGroupMode) => void
  setTabGroups: (groups: TabGroup[]) => void
  createTabGroup: (label: string) => string
  deleteTabGroup: (groupId: string) => void
  renameTabGroup: (groupId: string, label: string) => void
  setDefaultTabGroup: (groupId: string) => void
  reorderTabGroups: (reorderedGroups: TabGroup[]) => void
  setAutoGroupOrder: (order: string[]) => void
  setInProgressGroupId: (groupId: string | null) => void
  setDoneGroupId: (groupId: string | null) => void
  setCommitCommand: (cmd: string) => void
  setClaudeCommand: (cmd: string) => void
  /** Called by OS theme change listener — updates system value */
  setSystemTheme: (isDark: boolean) => void
}

/** Convert camelCase token name to --coda-kebab-case CSS custom property */
function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

/** Sync all JS design tokens to CSS custom properties on :root */
function syncTokensToCss(tokens: ColorPalette): void {
  const style = document.documentElement.style
  for (const [key, value] of Object.entries(tokens)) {
    style.setProperty(`--coda-${camelToKebab(key)}`, value)
  }
}

function applyTheme(isDark: boolean): void {
  document.documentElement.classList.toggle('dark', isDark)
  document.documentElement.classList.toggle('light', !isDark)
  syncTokensToCss(isDark ? darkColors : lightColors)
}

const SETTINGS_DEFAULTS = { themeMode: 'dark' as ThemeMode, soundEnabled: true, expandedUI: false, ultraWide: false, defaultBaseDirectory: '', recentBaseDirectories: [] as string[], preferredOpenWith: 'cli' as 'cli' | 'vscode', showImplementClearContext: false, defaultPermissionMode: 'plan' as 'ask' | 'auto' | 'plan', expandOnTabSwitch: true, bashCommandEntry: false, gitPanelSplitRatio: 0.4, gitPanelChangesOpen: true, gitPanelGraphOpen: true, expandToolResults: false, terminalFontFamily: 'Menlo, Monaco, monospace', terminalFontSize: 13, closeExplorerOnFileOpen: true, openMarkdownInPreview: true, editorWordWrap: true, gitOpsMode: 'manual' as GitOpsMode, worktreeCompletionStrategy: 'merge' as WorktreeCompletionStrategy, worktreeBranchDefaults: {} as Record<string, string>, worktreeSkipPrTitle: false, allowSettingsEdits: false, showTodoList: true, hideOnExternalLaunch: true, keepExplorerOnCollapse: false, keepTerminalOnCollapse: false, keepGitPanelOnCollapse: false, tabGroupMode: 'off' as TabGroupMode, tabGroups: [] as TabGroup[], autoGroupOrder: [] as string[], inProgressGroupId: null as string | null, doneGroupId: null as string | null, commitCommand: '', claudeCommand: '' }

function saveSettings(s: Record<string, unknown>): void {
  window.coda?.saveSettings(s)
}

function getAllSettings(get: () => ThemeState): Record<string, unknown> {
  const s = get()
  return { themeMode: s.themeMode, soundEnabled: s.soundEnabled, expandedUI: s.expandedUI, ultraWide: s.ultraWide, defaultBaseDirectory: s.defaultBaseDirectory, recentBaseDirectories: s.recentBaseDirectories, preferredOpenWith: s.preferredOpenWith, showImplementClearContext: s.showImplementClearContext, defaultPermissionMode: s.defaultPermissionMode, expandOnTabSwitch: s.expandOnTabSwitch, bashCommandEntry: s.bashCommandEntry, gitPanelSplitRatio: s.gitPanelSplitRatio, gitPanelChangesOpen: s.gitPanelChangesOpen, gitPanelGraphOpen: s.gitPanelGraphOpen, expandToolResults: s.expandToolResults, terminalFontFamily: s.terminalFontFamily, terminalFontSize: s.terminalFontSize, gitOpsMode: s.gitOpsMode, worktreeCompletionStrategy: s.worktreeCompletionStrategy, worktreeBranchDefaults: s.worktreeBranchDefaults, worktreeSkipPrTitle: s.worktreeSkipPrTitle, allowSettingsEdits: s.allowSettingsEdits, showTodoList: s.showTodoList, hideOnExternalLaunch: s.hideOnExternalLaunch, keepExplorerOnCollapse: s.keepExplorerOnCollapse, keepTerminalOnCollapse: s.keepTerminalOnCollapse, keepGitPanelOnCollapse: s.keepGitPanelOnCollapse, tabGroupMode: s.tabGroupMode, tabGroups: s.tabGroups, autoGroupOrder: s.autoGroupOrder, inProgressGroupId: s.inProgressGroupId, doneGroupId: s.doneGroupId, commitCommand: s.commitCommand, claudeCommand: s.claudeCommand }
}

/** Returns effective tab groups: custom groups if any exist, otherwise built-in defaults */
export function getEffectiveTabGroups(tabGroups: TabGroup[]): TabGroup[] {
  if (tabGroups.length > 0) return tabGroups
  return DEFAULT_TAB_GROUP_LABELS.map((label, i) => ({
    id: `default-${label.toLowerCase().replace(/\s+/g, '-')}`,
    label,
    isDefault: i === 0,
    order: i,
    collapsed: true,
  }))
}

// Start with defaults; async load from disk will update immediately after mount.
const saved = { ...SETTINGS_DEFAULTS, expandedUI: false }

export const useThemeStore = create<ThemeState>((set, get) => ({
  isDark: saved.themeMode === 'dark' ? true : saved.themeMode === 'light' ? false : true,
  themeMode: saved.themeMode,
  soundEnabled: saved.soundEnabled,
  expandedUI: saved.expandedUI,
  defaultBaseDirectory: saved.defaultBaseDirectory,
  recentBaseDirectories: saved.recentBaseDirectories,
  preferredOpenWith: saved.preferredOpenWith,
  showImplementClearContext: saved.showImplementClearContext,
  defaultPermissionMode: saved.defaultPermissionMode,
  expandOnTabSwitch: saved.expandOnTabSwitch,
  bashCommandEntry: saved.bashCommandEntry,
  gitPanelSplitRatio: saved.gitPanelSplitRatio,
  gitPanelChangesOpen: saved.gitPanelChangesOpen,
  gitPanelGraphOpen: saved.gitPanelGraphOpen,
  expandToolResults: saved.expandToolResults,
  terminalFontFamily: saved.terminalFontFamily,
  terminalFontSize: saved.terminalFontSize,
  closeExplorerOnFileOpen: saved.closeExplorerOnFileOpen,
  openMarkdownInPreview: saved.openMarkdownInPreview,
  editorWordWrap: saved.editorWordWrap,
  gitOpsMode: saved.gitOpsMode,
  worktreeCompletionStrategy: saved.worktreeCompletionStrategy,
  worktreeBranchDefaults: saved.worktreeBranchDefaults,
  worktreeSkipPrTitle: saved.worktreeSkipPrTitle,
  allowSettingsEdits: saved.allowSettingsEdits,
  showTodoList: saved.showTodoList,
  hideOnExternalLaunch: saved.hideOnExternalLaunch,
  keepExplorerOnCollapse: saved.keepExplorerOnCollapse,
  keepTerminalOnCollapse: saved.keepTerminalOnCollapse,
  keepGitPanelOnCollapse: saved.keepGitPanelOnCollapse,
  tabGroupMode: saved.tabGroupMode,
  tabGroups: saved.tabGroups,
  autoGroupOrder: saved.autoGroupOrder,
  inProgressGroupId: saved.inProgressGroupId,
  doneGroupId: saved.doneGroupId,
  commitCommand: saved.commitCommand,
  claudeCommand: saved.claudeCommand,
  _systemIsDark: true,
  setIsDark: (isDark) => {
    set({ isDark })
    applyTheme(isDark)
  },
  setThemeMode: (mode) => {
    const resolved = mode === 'system' ? get()._systemIsDark : mode === 'dark'
    set({ themeMode: mode, isDark: resolved })
    applyTheme(resolved)
    saveSettings(getAllSettings(get))
  },
  setSoundEnabled: (enabled) => {
    set({ soundEnabled: enabled })
    saveSettings(getAllSettings(get))
  },
  setExpandedUI: (expanded) => {
    set({ expandedUI: expanded })
    saveSettings(getAllSettings(get))
  },
  setUltraWide: (enabled) => {
    set({ ultraWide: enabled })
    saveSettings(getAllSettings(get))
  },
  setDefaultBaseDirectory: (dir) => {
    set({ defaultBaseDirectory: dir })
    saveSettings(getAllSettings(get))
  },
  addRecentBaseDirectory: (dir) => {
    const current = get().recentBaseDirectories.filter((d) => d !== dir)
    const updated = [dir, ...current].slice(0, 8)
    set({ recentBaseDirectories: updated })
    saveSettings(getAllSettings(get))
  },
  removeRecentBaseDirectory: (dir) => {
    const updated = get().recentBaseDirectories.filter((d) => d !== dir)
    set({ recentBaseDirectories: updated })
    saveSettings(getAllSettings(get))
  },
  setPreferredOpenWith: (app) => {
    set({ preferredOpenWith: app })
    saveSettings(getAllSettings(get))
  },
  setShowImplementClearContext: (show) => {
    set({ showImplementClearContext: show })
    saveSettings(getAllSettings(get))
  },
  setDefaultPermissionMode: (mode) => {
    set({ defaultPermissionMode: mode })
    saveSettings(getAllSettings(get))
  },
  setExpandOnTabSwitch: (enabled) => {
    set({ expandOnTabSwitch: enabled })
    saveSettings(getAllSettings(get))
  },
  setBashCommandEntry: (enabled) => {
    set({ bashCommandEntry: enabled })
    saveSettings(getAllSettings(get))
  },
  setGitPanelSplitRatio: (ratio) => {
    set({ gitPanelSplitRatio: ratio })
    saveSettings(getAllSettings(get))
  },
  setGitPanelChangesOpen: (open) => {
    set({ gitPanelChangesOpen: open })
    saveSettings(getAllSettings(get))
  },
  setGitPanelGraphOpen: (open) => {
    set({ gitPanelGraphOpen: open })
    saveSettings(getAllSettings(get))
  },
  setExpandToolResults: (enabled) => {
    set({ expandToolResults: enabled })
    saveSettings(getAllSettings(get))
  },
  setTerminalFontFamily: (font) => {
    set({ terminalFontFamily: font })
    saveSettings(getAllSettings(get))
  },
  setTerminalFontSize: (size) => {
    set({ terminalFontSize: size })
    saveSettings(getAllSettings(get))
  },
  setCloseExplorerOnFileOpen: (enabled) => {
    set({ closeExplorerOnFileOpen: enabled })
    saveSettings(getAllSettings(get))
  },
  setOpenMarkdownInPreview: (enabled) => {
    set({ openMarkdownInPreview: enabled })
    saveSettings(getAllSettings(get))
  },
  setEditorWordWrap: (enabled) => {
    set({ editorWordWrap: enabled })
    saveSettings(getAllSettings(get))
  },
  setGitOpsMode: (mode) => {
    set({ gitOpsMode: mode })
    saveSettings(getAllSettings(get))
  },
  setWorktreeCompletionStrategy: (strategy) => {
    set({ worktreeCompletionStrategy: strategy })
    saveSettings(getAllSettings(get))
  },
  setWorktreeBranchDefault: (repoPath, branch) => {
    const current = get().worktreeBranchDefaults
    set({ worktreeBranchDefaults: { ...current, [repoPath]: branch } })
    saveSettings(getAllSettings(get))
  },
  removeWorktreeBranchDefault: (repoPath) => {
    const current = { ...get().worktreeBranchDefaults }
    delete current[repoPath]
    set({ worktreeBranchDefaults: current })
    saveSettings(getAllSettings(get))
  },
  setWorktreeSkipPrTitle: (skip) => {
    set({ worktreeSkipPrTitle: skip })
    saveSettings(getAllSettings(get))
  },
  setAllowSettingsEdits: (enabled) => {
    set({ allowSettingsEdits: enabled })
    saveSettings(getAllSettings(get))
  },
  setShowTodoList: (enabled) => {
    set({ showTodoList: enabled })
    saveSettings(getAllSettings(get))
  },
  setHideOnExternalLaunch: (enabled) => {
    set({ hideOnExternalLaunch: enabled })
    saveSettings(getAllSettings(get))
  },
  setKeepExplorerOnCollapse: (enabled) => {
    set({ keepExplorerOnCollapse: enabled })
    saveSettings(getAllSettings(get))
  },
  setKeepTerminalOnCollapse: (enabled) => {
    set({ keepTerminalOnCollapse: enabled })
    saveSettings(getAllSettings(get))
  },
  setKeepGitPanelOnCollapse: (enabled) => {
    set({ keepGitPanelOnCollapse: enabled })
    saveSettings(getAllSettings(get))
  },
  setTabGroupMode: (mode) => {
    set({ tabGroupMode: mode })
    saveSettings(getAllSettings(get))
  },
  setTabGroups: (groups) => {
    set({ tabGroups: groups })
    saveSettings(getAllSettings(get))
  },
  createTabGroup: (label) => {
    const id = crypto.randomUUID()
    const current = get().tabGroups
    const isFirst = current.length === 0
    const group: TabGroup = { id, label, isDefault: isFirst, order: current.length, collapsed: true }
    set({ tabGroups: [...current, group] })
    saveSettings(getAllSettings(get))
    return id
  },
  deleteTabGroup: (groupId) => {
    const current = get().tabGroups
    const removing = current.find((g) => g.id === groupId)
    let updated = current.filter((g) => g.id !== groupId)
    // If we removed the default, assign default to first remaining
    if (removing?.isDefault && updated.length > 0) {
      updated = updated.map((g, i) => i === 0 ? { ...g, isDefault: true } : g)
    }
    // Reindex order
    updated = updated.map((g, i) => ({ ...g, order: i }))
    // Clear in-progress designation if this group was it
    const patch: Partial<ThemeState> = { tabGroups: updated }
    if (get().inProgressGroupId === groupId) patch.inProgressGroupId = null
    if (get().doneGroupId === groupId) patch.doneGroupId = null
    set(patch)
    saveSettings(getAllSettings(get))
  },
  renameTabGroup: (groupId, label) => {
    set({ tabGroups: get().tabGroups.map((g) => g.id === groupId ? { ...g, label } : g) })
    saveSettings(getAllSettings(get))
  },
  setDefaultTabGroup: (groupId) => {
    set({ tabGroups: get().tabGroups.map((g) => ({ ...g, isDefault: g.id === groupId })) })
    saveSettings(getAllSettings(get))
  },
  reorderTabGroups: (reorderedGroups) => {
    const updated = reorderedGroups.map((g, i) => ({ ...g, order: i }))
    set({ tabGroups: updated })
    saveSettings(getAllSettings(get))
  },
  setAutoGroupOrder: (order) => {
    set({ autoGroupOrder: order })
    saveSettings(getAllSettings(get))
  },
  setInProgressGroupId: (groupId) => {
    set({ inProgressGroupId: groupId })
    saveSettings(getAllSettings(get))
  },
  setDoneGroupId: (groupId) => {
    set({ doneGroupId: groupId })
    saveSettings(getAllSettings(get))
  },
  setCommitCommand: (cmd) => {
    set({ commitCommand: cmd })
    saveSettings(getAllSettings(get))
  },
  setClaudeCommand: (cmd) => {
    set({ claudeCommand: cmd })
    saveSettings(getAllSettings(get))
  },
  setSystemTheme: (isDark) => {
    set({ _systemIsDark: isDark })
    // Only apply if following system
    if (get().themeMode === 'system') {
      set({ isDark })
      applyTheme(isDark)
    }
  },
}))

// Initialize CSS vars with saved theme
syncTokensToCss(saved.themeMode === 'light' ? lightColors : darkColors)

// Load persisted settings from disk (async, fires once on startup)
window.coda?.loadSettings().then((disk) => {
  if (!disk) return
  const store = useThemeStore.getState()
  const mode = (['light', 'dark'].includes(disk.themeMode) ? disk.themeMode : 'dark') as ThemeMode
  const resolved = mode === 'system' ? store._systemIsDark : mode === 'dark'
  const sound = typeof disk.soundEnabled === 'boolean' ? disk.soundEnabled : true
  const expanded = typeof disk.expandedUI === 'boolean' ? disk.expandedUI : false
  const ultraWide = typeof disk.ultraWide === 'boolean' ? disk.ultraWide : false
  const baseDir = typeof disk.defaultBaseDirectory === 'string' ? disk.defaultBaseDirectory : ''
  const recentDirs = Array.isArray(disk.recentBaseDirectories) ? disk.recentBaseDirectories.filter((d: unknown) => typeof d === 'string').slice(0, 8) : []
  const openWith = (disk.preferredOpenWith === 'cli' || disk.preferredOpenWith === 'vscode') ? disk.preferredOpenWith : 'cli'
  const implClearCtx = typeof disk.showImplementClearContext === 'boolean' ? disk.showImplementClearContext : false
  const expandTabSwitch = typeof disk.expandOnTabSwitch === 'boolean' ? disk.expandOnTabSwitch : true
  const bashCmd = typeof disk.bashCommandEntry === 'boolean' ? disk.bashCommandEntry : false
  const splitRatio = typeof disk.gitPanelSplitRatio === 'number' ? disk.gitPanelSplitRatio : 0.4
  const changesOpen = typeof disk.gitPanelChangesOpen === 'boolean' ? disk.gitPanelChangesOpen : true
  const graphOpen = typeof disk.gitPanelGraphOpen === 'boolean' ? disk.gitPanelGraphOpen : true
  const expandTools = typeof disk.expandToolResults === 'boolean' ? disk.expandToolResults : false
  const termFont = typeof disk.terminalFontFamily === 'string' ? disk.terminalFontFamily : 'Menlo, Monaco, monospace'
  const termSize = typeof disk.terminalFontSize === 'number' ? disk.terminalFontSize : 13
  const closeExplorer = typeof disk.closeExplorerOnFileOpen === 'boolean' ? disk.closeExplorerOnFileOpen : true
  const mdPreview = typeof disk.openMarkdownInPreview === 'boolean' ? disk.openMarkdownInPreview : true
  const wordWrap = typeof disk.editorWordWrap === 'boolean' ? disk.editorWordWrap : true
  const gitOpsMode = (disk.gitOpsMode === 'manual' || disk.gitOpsMode === 'worktree') ? disk.gitOpsMode : 'manual'
  const wtStrategy = (disk.worktreeCompletionStrategy === 'merge' || disk.worktreeCompletionStrategy === 'pr') ? disk.worktreeCompletionStrategy : 'merge'
  const wtDefaults = (disk.worktreeBranchDefaults && typeof disk.worktreeBranchDefaults === 'object' && !Array.isArray(disk.worktreeBranchDefaults)) ? disk.worktreeBranchDefaults as Record<string, string> : {}
  const wtSkipPr = typeof disk.worktreeSkipPrTitle === 'boolean' ? disk.worktreeSkipPrTitle : false
  const allowSettings = typeof disk.allowSettingsEdits === 'boolean' ? disk.allowSettingsEdits : false
  const showTodo = typeof disk.showTodoList === 'boolean' ? disk.showTodoList : true
  const hideExternal = typeof disk.hideOnExternalLaunch === 'boolean' ? disk.hideOnExternalLaunch : true
  const tabGroupMode = (disk.tabGroupMode === 'off' || disk.tabGroupMode === 'auto' || disk.tabGroupMode === 'manual') ? disk.tabGroupMode : 'off'
  const tabGroups = Array.isArray(disk.tabGroups) ? (disk.tabGroups as TabGroup[]).filter((g: any) => g && typeof g.id === 'string' && typeof g.label === 'string') : []
  const autoGroupOrder = Array.isArray(disk.autoGroupOrder) ? (disk.autoGroupOrder as string[]).filter((d: unknown) => typeof d === 'string') : []
  const inProgressGroupId = typeof disk.inProgressGroupId === 'string' ? disk.inProgressGroupId : null
  const doneGroupId = typeof disk.doneGroupId === 'string' ? disk.doneGroupId : null
  const commitCommand = typeof disk.commitCommand === 'string' ? disk.commitCommand : ''
  const claudeCommand = typeof disk.claudeCommand === 'string' ? disk.claudeCommand : ''
  const keepExplorer = typeof disk.keepExplorerOnCollapse === 'boolean' ? disk.keepExplorerOnCollapse : false
  const keepTerminal = typeof disk.keepTerminalOnCollapse === 'boolean' ? disk.keepTerminalOnCollapse : false
  const keepGitPanel = typeof disk.keepGitPanelOnCollapse === 'boolean' ? disk.keepGitPanelOnCollapse : false
  const permMode = (disk.defaultPermissionMode === 'ask' || disk.defaultPermissionMode === 'auto' || disk.defaultPermissionMode === 'plan') ? disk.defaultPermissionMode : 'plan'
  useThemeStore.setState({ themeMode: mode, isDark: resolved, soundEnabled: sound, expandedUI: expanded, ultraWide, defaultBaseDirectory: baseDir, recentBaseDirectories: recentDirs, preferredOpenWith: openWith, showImplementClearContext: implClearCtx, expandOnTabSwitch: expandTabSwitch, bashCommandEntry: bashCmd, gitPanelSplitRatio: splitRatio, gitPanelChangesOpen: changesOpen, gitPanelGraphOpen: graphOpen, expandToolResults: expandTools, terminalFontFamily: termFont, terminalFontSize: termSize, closeExplorerOnFileOpen: closeExplorer, openMarkdownInPreview: mdPreview, editorWordWrap: wordWrap, gitOpsMode, worktreeCompletionStrategy: wtStrategy, worktreeBranchDefaults: wtDefaults, worktreeSkipPrTitle: wtSkipPr, allowSettingsEdits: allowSettings, showTodoList: showTodo, hideOnExternalLaunch: hideExternal, tabGroupMode: tabGroupMode as TabGroupMode, tabGroups, autoGroupOrder, inProgressGroupId, doneGroupId, commitCommand, claudeCommand, keepExplorerOnCollapse: keepExplorer, keepTerminalOnCollapse: keepTerminal, keepGitPanelOnCollapse: keepGitPanel, defaultPermissionMode: permMode })
  applyTheme(resolved)
})

/** Reactive hook — returns the active color palette */
export function useColors(): ColorPalette {
  const isDark = useThemeStore((s) => s.isDark)
  return isDark ? darkColors : lightColors
}

/** Non-reactive getter — use outside React components */
export function getColors(isDark: boolean): ColorPalette {
  return isDark ? darkColors : lightColors
}

// ─── Backward compatibility ───
// Legacy static export — components being migrated should use useColors() instead
export const colors = darkColors

// ─── Spacing ───

export const spacing = {
  contentWidth: 460,
  containerRadius: 20,
  containerPadding: 12,
  tabHeight: 32,
  inputMinHeight: 44,
  inputMaxHeight: 160,
  conversationMaxHeight: 380,
  pillRadius: 9999,
  circleSize: 36,
  circleGap: 8,
} as const

// ─── Animation ───

export const motion = {
  spring: { type: 'spring' as const, stiffness: 500, damping: 30 },
  easeOut: { duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] as const },
  fadeIn: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4 },
    transition: { duration: 0.15 },
  },
} as const
