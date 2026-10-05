import type { ProjectProfileOverride, ProjectRegistry } from '@ion/shared/project-registry'
import type { GitOpsMode, WorktreeCompletionStrategy, QuickTool, RemotePairedDevice, EngineProfile, NewConversationDefaultsPolicy, ThinkingEffort } from '@ion/shared/types'
import type { ModelEntry } from '@ion/shared/types-models'
import type { AiAssistWorkflowId } from '@ion/shared/ai-assist-workflows'
import type { EnterprisePolicy } from '@ion/shared/types-engine'
import { DEFAULT_MONO_FONT } from './typography'

/**
 * ShortcutView and KeyboardShortcuts are duplicated here (matching the
 * pre-existing duplication of ShortcutView between
 * desktop/src/renderer/preferences-shortcuts.ts and
 * desktop/src/renderer/shortcuts/shortcut-types.ts) rather than imported: the
 * canonical definitions live in preferences-shortcuts.ts, which depends on
 * rendererLogger (window.ion) and cannot be reached from this headless
 * package. Structurally identical string-literal/Record aliases, so every
 * consumer stays interchangeable.
 */
type ShortcutView = 'overlay' | 'studio'
type KeyboardShortcuts = Record<ShortcutView, Record<string, string>>


export type StudioSurfaceSwitchMode = 'preserve' | 'per-conversation'

export interface PreferencesState {
  /** Selected theme ID from the theme registry. Persisted in localStorage. */
  selectedTheme: string
  soundEnabled: boolean
  defaultBaseDirectory: string
  recentBaseDirectories: string[]
  directoryUsageCounts: Record<string, number>
  defaultPermissionMode: 'auto' | 'plan'
  /** Keep browser preview network access blocked until the user allows it. */
  browserPreviewNetworkShield: boolean
  /** Open the desktop app when this person signs in to the computer. The desktop's main process applies it. */
  openAtLogin: boolean
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
  /** Show dotfiles and OS-hidden entries in the file explorer. */
  showHiddenFiles: boolean
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
  /** Show each conversation's title in its push notifications (they pass through the relay and Apple in plain text) */
  pushConversationTitles: boolean
  /** Load commands and skills from .claude/ directories */
  enableClaudeCompat: boolean
  /**
   * Reply to the engine's wire-protocol before_early_stop_decision request
   * with a Claude-Code-style "Stopped at X% of token target… Keep working"
   * continuation prompt when the engine's tentative WouldContinue verdict
   * is true. Disable to never nudge the model regardless of the engine's
   * verdict. Read by engine/early-stop-policy.ts on every event,
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
  /** Remote control: relay server URL (empty = no relay) */
  relayUrl: string
  /** Remote control: relay API key */
  relayApiKey: string
  /**
   * Paired iOS devices from the retired `desktop_*` wire. Read-only now:
   * `auth/paired-device-migration.ts` copies each entry into
   * `credentials.json` at boot and deliberately leaves this key alone, so an
   * install that has not booted the new server yet is not stranded, and
   * `remote/paired-device-lookup.ts` still resolves a principal from it.
   */
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
  /** When a usage limit stops a conversation, hold the resume prompt and send it once the limit resets. */
  usageLimitAutoResume: boolean
  setUsageLimitAutoResume: (enabled: boolean) => void
  /** The prompt a resume at reset sends. */
  usageLimitResumePrompt: string
  setUsageLimitResumePrompt: (prompt: string) => void
  /** A weekly limit counts as about to expire once it resets within this many hours. 0 turns the alert and the spare-quota release off. */
  quotaExpiryAlertHours: number
  setQuotaExpiryAlertHours: (hours: number) => void
  /** And at least this percent of it is unused. */
  quotaExpiryUnusedPercent: number
  setQuotaExpiryUnusedPercent: (percent: number) => void
  /** Controlled machine-local Project registry. */
  projectSettingsVersion: number
  projects: ProjectRegistry
  addProject: (dir: string) => void
  removeProject: (dir: string) => void
  setDefaultProject: (dir: string | null) => void
  setProjectName: (dir: string, name: string | null) => void
  setProjectProfileOverride: (dir: string, override: ProjectProfileOverride | undefined) => void
  /** Save or clear (undefined) the project's remembered worktree ephemeral answer. */
  setProjectWorktreeEphemeral: (dir: string, ephemeral: boolean | undefined) => void
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
  setTabRecoveryEnabled: (enabled: boolean) => void
  setTabRecoveryTimeoutSec: (sec: number) => void
  setSelectedTheme: (id: string) => void
  setSoundEnabled: (enabled: boolean) => void
  setDefaultBaseDirectory: (dir: string) => void
  addRecentBaseDirectory: (dir: string) => void
  removeRecentBaseDirectory: (dir: string) => void
  setDefaultPermissionMode: (mode: 'auto' | 'plan') => void
  setBrowserPreviewNetworkShield: (enabled: boolean) => void
  setOpenAtLogin: (enabled: boolean) => void
  setStudioPlaywrightEnabled: (enabled: boolean) => void
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
  setShowHiddenFiles: (show: boolean) => void
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
  setPushConversationTitles: (enabled: boolean) => void
  setEnableClaudeCompat: (enabled: boolean) => void
  setEnableEarlyStopContinuation: (enabled: boolean) => void
  setShowTodoList: (enabled: boolean) => void
  setAgentPanelDefaultOpen: (enabled: boolean) => void
  setUnifiedTurnView: (enabled: boolean) => void
  setAiGeneratedTitles: (enabled: boolean) => void
  setDefaultThinkingEffort: (effort: ThinkingEffort) => void
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
  setRelayUrl: (url: string) => void
  setRelayApiKey: (key: string) => void
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

export const SETTINGS_DEFAULTS = { selectedTheme: 'ion-dark', soundEnabled: true, defaultBaseDirectory: '', recentBaseDirectories: [] as string[], directoryUsageCounts: {} as Record<string, number>, defaultPermissionMode: 'plan' as 'auto' | 'plan', browserPreviewNetworkShield: true, openAtLogin: false, studioPlaywrightEnabled: true, studioSurfaceSwitchMode: 'preserve' as StudioSurfaceSwitchMode, bashCommandEntry: false, gitPanelPaneProportions: {} as Record<string, number>, gitPanelHeight: null as number | null, fileExplorerHeight: null as number | null, gitPanelChangesOpen: true, gitPanelGraphOpen: true, expandToolResults: false, terminalFontFamily: DEFAULT_MONO_FONT, terminalFontSize: 13, showHiddenFiles: false, openMarkdownInPreview: true, editorWordWrap: true, editorFontSize: 12, dataViewFontSize: 13, gitOpsMode: 'manual' as GitOpsMode, worktreeCompletionStrategy: 'merge-ff' as WorktreeCompletionStrategy, worktreeBranchDefaults: {} as Record<string, string>, worktreeSkipPrTitle: false, allowSettingsEdits: false, pushConversationTitles: true, enableClaudeCompat: false, enableEarlyStopContinuation: false, showTodoList: true, agentPanelDefaultOpen: true, unifiedTurnView: true, aiGeneratedTitles: true, commitCommand: '', aiAssistPromptOverrides: {} as Partial<Record<AiAssistWorkflowId, string>>, gitChangesTreeView: false, quickTools: [] as QuickTool[], uiZoom: 1, relayUrl: '', relayApiKey: '', pairedDevices: [] as RemotePairedDevice[], streamThinkingToRemote: true, defaultThinkingEffort: 'medium' as ThinkingEffort, remoteDisplay: null as { customName: string | null; customIcon: string | null; updatedAt: number } | null, engineDefaultModel: '', preferredModel: '', defaultEngineProfileId: '', engineProfiles: [] as EngineProfile[], tabRecoveryEnabled: true, tabRecoveryTimeoutSec: 120, planModelSplitEnabled: false, planModeModel: '', implementModeModel: '', showImplementClearContext: false, gitWatcherIgnoredDirectories: ['~/.ion'] as string[], workspaceFolders: {} as Record<string, string[]>, gitPanelRepoSectionsCollapsed: {} as Record<string, boolean>, inboxAutoSettleDays: 0, usageLimitAutoResume: false, usageLimitResumePrompt: "Continue where you left off.", quotaExpiryAlertHours: 12, quotaExpiryUnusedPercent: 25, projectSettingsVersion: 1, projects: {} as ProjectRegistry, excludedResourceKinds: [] as string[], keyboardShortcuts: { overlay: {}, studio: {} } as KeyboardShortcuts }
