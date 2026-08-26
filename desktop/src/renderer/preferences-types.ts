import type { ProjectProfileOverride, ProjectRegistry } from '../shared/project-registry'
import type { GitOpsMode, WorktreeCompletionStrategy, TabGroupMode, TabGroup, QuickTool, RemotePairedDevice, EngineProfile, NewConversationDefaultsPolicy, ThinkingEffort } from '../shared/types'
import type { ModelEntry } from '../shared/types-models'
import type { AiAssistWorkflowId } from '../shared/ai-assist-workflows'
import type { EnterprisePolicy } from '../shared/types-engine'
import type { KeyboardShortcuts, ShortcutView } from './preferences-shortcuts'


export type StudioSurfaceSwitchMode = 'preserve' | 'per-conversation'

export interface PreferencesState {
  /** Selected theme ID from the theme registry. Persisted in localStorage. */
  selectedTheme: string
  soundEnabled: boolean
  expandedUI: boolean
  ultraWide: boolean
  defaultBaseDirectory: string
  recentBaseDirectories: string[]
  directoryUsageCounts: Record<string, number>
  defaultPermissionMode: 'auto' | 'plan'
  expandOnTabSwitch: boolean
  /** Keep browser preview network access blocked until the user allows it. */
  browserPreviewNetworkShield: boolean
  /**
   * Let agents in Studio drive the Chromium tabs in their conversation's
   * Surface panel. Disabling withdraws the tools only: browser tabs, sessions,
   * logins, and emulation state are untouched.
   */
  studioPlaywrightEnabled: boolean
  /** Controls whether Studio surface visibility follows the current window or each conversation. */
  studioSurfaceSwitchMode: StudioSurfaceSwitchMode
  bashCommandEntry: boolean
  /**
   * Per-pane share of the git panel, keyed by pane id. Proportions rather than
   * pixels so a sizing survives a window resize and the overlay/Studio height
   * difference — the same model VS Code's SplitView persists.
   *
   * A missing pane takes an equal share, so this can be partial or empty.
   */
  gitPanelPaneProportions: Record<string, number>
  /**
   * Operator-dragged panel heights, in pixels. Null means "use the default",
   * which is also the floor a drag cannot go below. Persisted so a sized
   * panel survives a restart; the render path re-clamps against the live
   * window height (resolvePanelHeight), so a value saved on a big display is
   * safe on a small one.
   */
  gitPanelHeight: number | null
  fileExplorerHeight: number | null
  gitPanelChangesOpen: boolean
  gitPanelGraphOpen: boolean
  expandToolResults: boolean
  terminalFontFamily: string
  terminalFontSize: number
  closeExplorerOnFileOpen: boolean
  openMarkdownInPreview: boolean
  editorWordWrap: boolean
  /** Font size for editable CodeMirror content in pixels. */
  editorFontSize: number
  /** Font size for read-only long-form data views in pixels. */
  dataViewFontSize: number
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
  /** Load commands and skills from .claude/ directories */
  enableClaudeCompat: boolean
  /**
   * Reply to the engine's wire-protocol before_early_stop_decision request
   * with a Claude-Code-style "Stopped at X% of token target… Keep working"
   * continuation prompt when the engine's tentative WouldContinue verdict
   * is true. Disable to never nudge the model regardless of the engine's
   * verdict. Read by desktop/src/main/early-stop-policy.ts on every event,
   * so a flip takes effect on the next decision. Default true.
   */
  enableEarlyStopContinuation: boolean
  /** Show the todo/task list panel at the bottom of the conversation */
  showTodoList: boolean
  /** Automatically expand the agent panel when agents are dispatched */
  agentPanelDefaultOpen: boolean
  /** Group tool calls and assistant text into unified turn blocks */
  unifiedTurnView: boolean
  /** Use AI to generate descriptive tab titles from the first message */
  aiGeneratedTitles: boolean
  /** Hide Ion overlay when launching external apps (Finder, Terminal, VS Code, etc.) */
  hideOnExternalLaunch: boolean
  /** Keep explorer open when conversation is minimized */
  keepExplorerOnCollapse: boolean
  /** Keep terminal open when conversation is minimized */
  keepTerminalOnCollapse: boolean
  /** Keep git panel open when conversation is minimized */
  keepGitPanelOnCollapse: boolean
  /** Keep the status drawer open when conversation is minimized */
  keepStatusDrawerOnCollapse: boolean
  /** Tab grouping mode: off (flat), auto (by directory), manual (user-defined groups) */
  tabGroupMode: TabGroupMode
  /** Manual/auto tab group definitions */
  tabGroups: TabGroup[]
  /** Persisted ordering for auto-mode groups (directory paths in order) */
  autoGroupOrder: string[]
  /** Stashed manual group definitions for roundtrip restoration */
  stashedManualGroups: TabGroup[]
  /** Stashed tab-to-group assignments (tabId → groupId) for roundtrip restoration */
  stashedManualTabAssignments: Record<string, string>
  /** Group ID that tabs auto-move into when implementation starts (null = disabled) */
  inProgressGroupId: string | null
  /** Group ID that tabs move into after committing (null = disabled) */
  doneGroupId: string | null
  /** Group ID that tabs in plan mode auto-move to (null = disabled) */
  planningGroupId: string | null
  /** Automatically move tabs between groups based on mode changes */
  autoGroupMovement: boolean
  /** Custom bash command to run instead of prompting the LLM for commits */
  commitCommand: string
  /** User replacements for complete Desktop AI-assisted workflow prompts. */
  aiAssistPromptOverrides: Partial<Record<AiAssistWorkflowId, string>>
  /** Show changed files grouped by directory in tree view */
  gitChangesTreeView: boolean
  /** User-configured quick tool buttons */
  quickTools: QuickTool[]
  /** UI zoom level (CSS zoom on :root, 0.5--2.0) */
  uiZoom: number
  /** Remote control: master toggle */
  remoteEnabled: boolean
  /** Remote control: relay server URL (empty = no relay) */
  relayUrl: string
  /** Remote control: relay API key */
  relayApiKey: string
  /** Remote control: LAN server port */
  lanServerPort: number
  /** Remote control: paired iOS devices */
  pairedDevices: RemotePairedDevice[]
  /**
   * Low-bandwidth projection toggle (issue #158). When true (default), the
   * desktop forwards the model's extended-thinking deltas
   * (`engine_thinking_delta`) to paired iOS devices alongside the block
   * boundaries. When false, the desktop DROPS the deltas before
   * `remoteTransport.send` while still forwarding `engine_thinking_block_start`
   * and `engine_thinking_block_end`, so the phone always sees the reasoning
   * boundaries (and never looks stalled) but skips the per-token reasoning
   * stream. Read by the main process at the forward path in event-wiring.ts.
   * This is the first facet of a future broader low-bandwidth mode.
   */
  streamThinkingToRemote: boolean
  /**
   * Level a NEW conversation's thinking control starts at. 'high' is the
   * desktop's opinionated default; the user can change any individual
   * conversation with the status-bar picker. Mirrors the projectable
   * `defaultThinkingEffort` setting.
   */
  defaultThinkingEffort: ThinkingEffort
  /**
   * Per-desktop display override that is broadcast to all paired iOS devices.
   * `null` means "use the OS hostname + default icon". `updatedAt` is used
   * for last-write-wins reconciliation between iOS edits and desktop edits.
   */
  remoteDisplay: { customName: string | null; customIcon: string | null; updatedAt: number } | null
  /** Engine: default model override (empty = use default) */
  engineDefaultModel: string
  /** Preferred model for new conversations (persisted across restarts) */
  preferredModel: string
  /**
   * Default engine profile for new tabs. Empty string means "plain
   * conversation" (no extension). A non-empty value is an EngineProfile id;
   * if the referenced profile no longer exists the desktop falls back to
   * plain. Set from the Settings dialog (Phase 3 UI, #256).
   */
  defaultEngineProfileId: string
  /** Named engine profiles for tab creation */
  engineProfiles: EngineProfile[]
  /**
   * Enterprise new-tab policy fetched from the engine at startup.
   * null means no enterprise config is active.
   * Not persisted to disk — always loaded fresh from the engine.
   */
  enterpriseNewConversationDefaults: NewConversationDefaultsPolicy | null
  /**
   * Full enterprise policy blob (D-004) fetched from the engine at startup.
   * null means no enterprise config is active. Read-only runtime constraint:
   * not persisted to disk, not user-editable, refreshed only by re-fetch.
   * Consumed by the model picker (allowedModels filtering, D-011) and any
   * other renderer surface that honors enterprise constraints.
   */
  enterprisePolicy: EnterprisePolicy | null
  /** Default tall mode. One flag for every conversation tab (the engine-
   *  specific default was collapsed away), plus a terminal-specific flag. */
  defaultTallConversation: boolean
  defaultTallTerminal: boolean
  /** Auto-recover tabs that appear stuck (no engine events for a period) */
  tabRecoveryEnabled: boolean
  /** Idle threshold in seconds before a stuck tab is force-recovered */
  tabRecoveryTimeoutSec: number
  /** Automatically switch models at the plan→implement boundary */
  planModelSplitEnabled: boolean
  /** Model to use when entering plan mode (empty = use preferredModel) */
  planModeModel: string
  /** Model to use when implementing a plan (empty = use preferredModel) */
  implementModeModel: string
  /** Directories where the git file watcher is suppressed. Supports ~ and $HOME. */
  gitWatcherIgnoredDirectories: string[]
  /**
   * Multi-root workspace folders, PER-PROJECT (D3): normalized primary/base
   * dir → additional roots shown in the explorer and git panel when a
   * conversation in that project is active. Machine-local absolute paths —
   * NOT projectable to iOS (directory-picker precedent).
   */
  workspaceFolders: Record<string, string[]>
  /** Persisted per-repo collapse state of git-panel repo sections. */
  gitPanelRepoSectionsCollapsed: Record<string, boolean>
  /** Inbox auto-settle threshold in days (0 = off). */
  inboxAutoSettleDays: number
  setInboxAutoSettleDays: (days: number) => void
  /** Automatically settle merged change requests. Closed change requests always settle. */
  inboxAutoSettleOnMerge: boolean
  setInboxAutoSettleOnMerge: (enabled: boolean) => void
  /** Studio conversation navigation: 'tabs' (TabStrip) | 'inbox' (inbox dock, TabStrip hidden). Per-device. */
  conversationNav: 'tabs' | 'inbox'
  setConversationNav: (nav: 'tabs' | 'inbox') => void
  /** Controlled machine-local Project registry. */
  projectSettingsVersion: number
  projects: ProjectRegistry
  addProject: (dir: string) => void
  removeProject: (dir: string) => void
  setDefaultProject: (dir: string | null) => void
  setProjectName: (dir: string, name: string | null) => void
  setProjectProfileOverride: (dir: string, override: ProjectProfileOverride | undefined) => void
  /**
   * Resource kinds the user has chosen to hide from the global/workspace
   * notification tray. Blocklist semantics: empty (the default) shows every
   * kind any extension declares. Only the global tray honors this list;
   * conversation-scoped resources always appear in their conversation's
   * attachments panel regardless. The desktop always subscribes to every
   * kind via the engine wildcard — this is purely a client-side render
   * filter, not a subscription opinion.
   */
  excludedResourceKinds: string[]
  /**
   * When true, reveals a second action on the plan-approval card:
   * **"Implement, clear context"**. Clicking that button destroys the
   * current engine session and starts a fresh conversation for the
   * implement phase (the historical behavior). The regular **Implement**
   * button always stays in the same conversation — the model retains
   * everything it learned during planning, the plan-mode system prompt
   * is dropped, and the EnterPlanMode sentinel tool is suppressed (via
   * ClientCommand.ImplementationPhase) so it can't be re-proposed.
   *
   * Granularity is per-plan: the user decides at click-time whether
   * they want a fresh conversation for this particular plan. There is
   * no global "always clear context" toggle — that would force the
   * behavior across every plan, every tab.
   *
   * Users can also manually clear context with `/clear` regardless of
   * this preference.
   *
   * Engine-tab support: the opt-in reset path is not yet wired for
   * engine tabs (no `engineResetSession` IPC exists). When the user
   * clicks "Implement, clear context" on an engine tab, the renderer
   * logs a warning and falls back to the no-reset path. CLI tabs and
   * iOS-driven CLI tabs honor the action fully.
   */
  showImplementClearContext: boolean
  /** Per-view keyboard shortcut overrides. Only non-default entries are stored. */
  keyboardShortcuts: KeyboardShortcuts
  setDefaultTallConversation: (enabled: boolean) => void
  setDefaultTallTerminal: (enabled: boolean) => void
  setTabRecoveryEnabled: (enabled: boolean) => void
  setTabRecoveryTimeoutSec: (sec: number) => void
  setSelectedTheme: (id: string) => void
  setSoundEnabled: (enabled: boolean) => void
  setExpandedUI: (expanded: boolean) => void
  setUltraWide: (enabled: boolean) => void
  setDefaultBaseDirectory: (dir: string) => void
  addRecentBaseDirectory: (dir: string) => void
  removeRecentBaseDirectory: (dir: string) => void
  setDefaultPermissionMode: (mode: 'auto' | 'plan') => void
  setBrowserPreviewNetworkShield: (enabled: boolean) => void
  setStudioPlaywrightEnabled: (enabled: boolean) => void
  setExpandOnTabSwitch: (enabled: boolean) => void
  setStudioSurfaceSwitchMode: (mode: StudioSurfaceSwitchMode) => void
  setBashCommandEntry: (enabled: boolean) => void
  setGitPanelPaneProportions: (proportions: Record<string, number>) => void
  setGitPanelHeight: (height: number | null) => void
  setFileExplorerHeight: (height: number | null) => void
  setGitPanelChangesOpen: (open: boolean) => void
  setGitPanelGraphOpen: (open: boolean) => void
  setExpandToolResults: (enabled: boolean) => void
  setTerminalFontFamily: (font: string) => void
  setTerminalFontSize: (size: number) => void
  setCloseExplorerOnFileOpen: (enabled: boolean) => void
  setOpenMarkdownInPreview: (enabled: boolean) => void
  setEditorWordWrap: (enabled: boolean) => void
  setEditorFontSize: (size: number) => void
  setDataViewFontSize: (size: number) => void
  setGitOpsMode: (mode: GitOpsMode) => void
  setWorktreeCompletionStrategy: (strategy: WorktreeCompletionStrategy) => void
  setWorktreeBranchDefault: (repoPath: string, branch: string) => void
  removeWorktreeBranchDefault: (repoPath: string) => void
  setWorktreeSkipPrTitle: (skip: boolean) => void
  setAllowSettingsEdits: (enabled: boolean) => void
  setEnableClaudeCompat: (enabled: boolean) => void
  setEnableEarlyStopContinuation: (enabled: boolean) => void
  setShowTodoList: (enabled: boolean) => void
  setAgentPanelDefaultOpen: (enabled: boolean) => void
  setUnifiedTurnView: (enabled: boolean) => void
  setAiGeneratedTitles: (enabled: boolean) => void
  setHideOnExternalLaunch: (enabled: boolean) => void
  setKeepExplorerOnCollapse: (enabled: boolean) => void
  setKeepTerminalOnCollapse: (enabled: boolean) => void
  setKeepGitPanelOnCollapse: (enabled: boolean) => void
  setKeepStatusDrawerOnCollapse: (enabled: boolean) => void
  setTabGroupMode: (mode: TabGroupMode) => void
  setTabGroups: (groups: TabGroup[]) => void
  createTabGroup: (label: string) => string
  deleteTabGroup: (groupId: string) => void
  renameTabGroup: (groupId: string, label: string) => void
  setDefaultTabGroup: (groupId: string) => void
  reorderTabGroups: (reorderedGroups: TabGroup[]) => void
  setAutoGroupOrder: (order: string[]) => void
  setStashedManualGroups: (groups: TabGroup[], assignments: Record<string, string>) => void
  setInProgressGroupId: (groupId: string | null) => void
  setDoneGroupId: (groupId: string | null) => void
  setPlanningGroupId: (groupId: string | null) => void
  setDefaultThinkingEffort: (effort: ThinkingEffort) => void
  setAutoGroupMovement: (enabled: boolean) => void
  setCommitCommand: (cmd: string) => void
  setAiAssistPromptOverride: (workflowId: AiAssistWorkflowId, prompt: string | null) => void
  setGitChangesTreeView: (enabled: boolean) => void
  setQuickTools: (tools: QuickTool[]) => void
  addQuickTool: (tool: QuickTool) => void
  removeQuickTool: (toolId: string) => void
  updateQuickTool: (toolId: string, updates: Partial<QuickTool>) => void
  setUiZoom: (zoom: number) => void
  zoomIn: () => void
  zoomOut: () => void
  setRemoteEnabled: (enabled: boolean) => void
  setRelayUrl: (url: string) => void
  setRelayApiKey: (key: string) => void
  setLanServerPort: (port: number) => void
  setStreamThinkingToRemote: (enabled: boolean) => void
  addPairedDevice: (device: RemotePairedDevice) => void
  removePairedDevice: (deviceId: string) => void
  /**
   * Update the desktop's display override. Pass `null` for either field to
   * clear it. Bumps `updatedAt = Date.now()` and persists via the renderer's
   * standard saveSettings path. Does NOT call the main-process broadcast
   * helper directly — the renderer calls `window.ion.remoteSetDisplay(...)`
   * which funnels through `setRemoteDisplay()` in main.
   */
  setRemoteDisplay: (customName: string | null, customIcon: string | null) => void
  setEngineDefaultModel: (model: string) => void
  setPreferredModel: (model: string) => void
  setDefaultEngineProfileId: (profileId: string) => void
  /** Load the enterprise new-tab policy from the engine and store it. Not persisted. */
  setEnterpriseNewConversationDefaults: (policy: NewConversationDefaultsPolicy | null) => void
  setEnterprisePolicy: (policy: EnterprisePolicy | null) => void
  addEngineProfile: (profile: EngineProfile) => void
  updateEngineProfile: (id: string, updates: Partial<EngineProfile>) => void
  removeEngineProfile: (id: string) => void
  setPlanModelSplitEnabled: (enabled: boolean) => void
  setPlanModeModel: (model: string) => void
  setImplementModeModel: (model: string) => void
  /** Atomically normalize persisted model preferences from live provider entries. */
  normalizeModelPreferences: (models: ModelEntry[]) => void
  setGitWatcherIgnoredDirectories: (dirs: string[]) => void
  /** Add an extra workspace root for a project (both paths normalized). */
  addWorkspaceFolder: (primaryDir: string, dir: string) => void
  /** Remove a workspace root; prunes its persisted collapse state. */
  removeWorkspaceFolder: (primaryDir: string, dir: string) => void
  /** Persist a git-panel repo section's collapse state. */
  setGitPanelRepoSectionCollapsed: (dir: string, collapsed: boolean) => void
  setExcludedResourceKinds: (kinds: string[]) => void
  setShowImplementClearContext: (enabled: boolean) => void
  /** Set a single view-specific keyboard shortcut override. Rejects invalid chords. */
  setKeyboardShortcut: (view: ShortcutView, commandId: string, chord: string) => void
  /** Remove one view-specific override, restoring its catalog default. */
  resetKeyboardShortcut: (view: ShortcutView, commandId: string) => void
  /** Clear a view's overrides, restoring its catalog defaults. */
  resetKeyboardShortcuts: (view: ShortcutView) => void
  /** Clear overrides for every view, restoring every catalog default. */
  resetAllKeyboardShortcuts: () => void
  /** Called by OS theme change listener -- updates system value */
  /** Apply a settings preset (batch-set multiple fields at once) */
  applyPreset: (preset: Record<string, unknown>) => void
}

export const SETTINGS_DEFAULTS = { selectedTheme: 'ion-dark', soundEnabled: true, expandedUI: false, ultraWide: false, defaultBaseDirectory: '', recentBaseDirectories: [] as string[], directoryUsageCounts: {} as Record<string, number>, defaultPermissionMode: 'plan' as 'auto' | 'plan', browserPreviewNetworkShield: true, studioPlaywrightEnabled: true, expandOnTabSwitch: true, studioSurfaceSwitchMode: 'preserve' as StudioSurfaceSwitchMode, bashCommandEntry: false, gitPanelPaneProportions: {} as Record<string, number>, gitPanelHeight: null as number | null, fileExplorerHeight: null as number | null, gitPanelChangesOpen: true, gitPanelGraphOpen: true, expandToolResults: false, terminalFontFamily: 'Menlo, Monaco, monospace', terminalFontSize: 13, closeExplorerOnFileOpen: true, openMarkdownInPreview: true, editorWordWrap: true, editorFontSize: 12, dataViewFontSize: 13, gitOpsMode: 'manual' as GitOpsMode, worktreeCompletionStrategy: 'merge-ff' as WorktreeCompletionStrategy, worktreeBranchDefaults: {} as Record<string, string>, worktreeSkipPrTitle: false, allowSettingsEdits: false, enableClaudeCompat: false, enableEarlyStopContinuation: false, showTodoList: true, agentPanelDefaultOpen: true, unifiedTurnView: true, aiGeneratedTitles: true, hideOnExternalLaunch: true, keepExplorerOnCollapse: false, keepTerminalOnCollapse: false, keepGitPanelOnCollapse: false, keepStatusDrawerOnCollapse: false, tabGroupMode: 'off' as TabGroupMode, tabGroups: [] as TabGroup[], autoGroupOrder: [] as string[], stashedManualGroups: [] as TabGroup[], stashedManualTabAssignments: {} as Record<string, string>, inProgressGroupId: null as string | null, doneGroupId: null as string | null, planningGroupId: null as string | null, autoGroupMovement: false, commitCommand: '', aiAssistPromptOverrides: {} as Partial<Record<AiAssistWorkflowId, string>>, gitChangesTreeView: false, quickTools: [] as QuickTool[], uiZoom: 1, remoteEnabled: false, relayUrl: '', relayApiKey: '', lanServerPort: 19837, pairedDevices: [] as RemotePairedDevice[], streamThinkingToRemote: true, defaultThinkingEffort: 'high' as ThinkingEffort, remoteDisplay: null as { customName: string | null; customIcon: string | null; updatedAt: number } | null, engineDefaultModel: '', preferredModel: 'claude-opus-4-6', defaultEngineProfileId: '', engineProfiles: [] as EngineProfile[], defaultTallConversation: false, defaultTallTerminal: false, tabRecoveryEnabled: true, tabRecoveryTimeoutSec: 120, planModelSplitEnabled: false, planModeModel: '', implementModeModel: '', showImplementClearContext: false, gitWatcherIgnoredDirectories: ['~/.ion'] as string[], workspaceFolders: {} as Record<string, string[]>, gitPanelRepoSectionsCollapsed: {} as Record<string, boolean>, inboxAutoSettleDays: 0, inboxAutoSettleOnMerge: true, conversationNav: 'tabs' as 'tabs' | 'inbox', projectSettingsVersion: 1, projects: {} as ProjectRegistry, excludedResourceKinds: [] as string[], keyboardShortcuts: { overlay: {}, studio: {} } as KeyboardShortcuts }
