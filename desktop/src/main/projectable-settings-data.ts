/**
 * Per-key entries for the projectable-settings allowlist.
 *
 * Split out of `projectable-settings.ts` to stay under the 600-line TS
 * file cap. The array below is the entire allowlist; the parent module
 * imports it as `PROJECTABLE_SETTINGS`.
 *
 * Every entry conforms to the `ProjectableSetting` interface declared in
 * the parent module. Adding a new entry only requires touching this file
 * (and the test, to cover any new type-specific branches).
 *
 * Grouping rationale lives at the top of each section banner. The
 * groupings mirror the desktop's own Settings dialog categories (see
 * `desktop/src/renderer/components/SettingsDialog.tsx`).
 */

import type { ProjectableSetting } from './projectable-settings-types'
import {
  QUICK_TOOL_ITEM_SCHEMA,
  TAB_GROUP_ITEM_SCHEMA,
} from './projectable-settings-items'
import { PROJECTABLE_SETTINGS_TAIL } from './projectable-settings-tail'

export { CONNECTION_CRITICAL_KEYS } from './projectable-settings-critical-keys'
export { ENGINE_CONFIG_BACKED_KEYS } from './projectable-settings-engine-config'

export const PROJECTABLE_SETTINGS_DATA: readonly ProjectableSetting[] = [
  // ═══════════════════════════════════════════════════════════════════
  // GENERAL
  // ───────────────────────────────────────────────────────────────────
  // Workspace defaults and behavioral toggles. Matches the desktop
  // GeneralCategory contents (minus the directory-picker, which is
  // local-fs).
  // ═══════════════════════════════════════════════════════════════════
  {
    key: 'defaultPermissionMode',
    iosSurface: 'phone',
    type: 'enum',
    group: 'general',
    label: 'Default Permission Mode',
    description: 'The permission mode new tabs start with.',
    defaultValue: 'plan',
    choices: [
      { value: 'plan', label: 'Plan' },
      { value: 'auto', label: 'Auto' },
    ],
  },
  {
    key: 'bashCommandEntry',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'general',
    label: 'Bash command entry (! prefix)',
    description:
      'Allow `!command` in the prompt input to execute a shell command before the prompt is sent.',
    defaultValue: false,
  },
  {
    key: 'allowSettingsEdits',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'general',
    label: 'Allow settings edits by the agent',
    description:
      'Show an approval card when the agent tries to edit its own settings files, instead of blocking outright.',
    defaultValue: false,
  },
  {
    key: 'enableClaudeCompat',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'general',
    label: 'Claude Code compatibility',
    description:
      'Load .claude content alongside the always-on .ion roots: .claude/commands and .claude/skills in slash discovery and resolution, and CLAUDE.md context files. For users migrating from or co-running Claude Code. Off by default; .ion content needs no flag.',
    defaultValue: false,
  },
  {
    key: 'enableEarlyStopContinuation',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'general',
    label: 'Early-stop continuation nudge',
    description:
      'When the model emits end_turn below the configured token budget, ask it to keep working instead of completing the run.',
    defaultValue: false,
  },
  {
    key: 'soundEnabled',
    iosSurface: 'phone-critical',
    type: 'boolean',
    group: 'general',
    label: 'Notification sound',
    description: 'Play a sound when a task completes on the desktop.',
    defaultValue: true,
  },
  {
    key: 'showTodoList',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'general',
    label: 'Show TODO list panel',
    description:
      'Render the TODO list panel for tabs that have an active TodoWrite tool.',
    defaultValue: true,
  },
  {
    key: 'agentPanelDefaultOpen',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'general',
    label: 'Agent panel open by default',
    description:
      'Automatically expand the agent panel when agents are dispatched. Disable to keep it collapsed until manually opened.',
    defaultValue: true,
  },
  {
    key: 'aiGeneratedTitles',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'general',
    label: 'AI-generated tab titles',
    description:
      'After the first user message, ask the model to generate a short title for the tab.',
    defaultValue: true,
  },
  {
    key: 'showImplementClearContext',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'general',
    label: 'Show "Implement, clear context" button',
    description:
      'Reveal a second button on the plan-approval card that starts a fresh conversation for the implementation phase. The regular Implement button always preserves the conversation. Use /clear to clear context manually at any time.',
    defaultValue: false,
  },
  {
    // Low-bandwidth mode, facet 1 (issue #158): stream the model's
    // extended-thinking deltas to paired iOS devices. Default ON. When
    // OFF, the desktop DROPS `engine_thinking_delta` events before
    // forwarding to iOS but ALWAYS forwards the block_start / block_end
    // boundaries, so the phone still shows the "💭 Thought for Ns" summary
    // and never looks stalled — it just skips the per-token reasoning
    // stream over the wire. This is the first toggle of a planned broader
    // low-bandwidth mode; later facets (tool-output truncation, etc.) will
    // join it under the same heading. Projected under `general` because the
    // `remote` desktop category is NOT on the iOS allowlist (pairing and
    // transport state are iOS-local); the desktop UI for this toggle lives
    // in RemoteCategory, but its iOS-visible home is the General section.
    // Read by the main process at the iOS forward path (event-wiring.ts).
    key: 'streamThinkingToRemote',
    iosSurface: 'phone-critical',
    type: 'boolean',
    group: 'general',
    label: 'Stream reasoning to phone (low-bandwidth mode)',
    description:
      "Forward the model's live reasoning text to paired iOS devices. When off, the phone still sees that the model thought (and for how long) but skips the per-token reasoning stream to save bandwidth. The first facet of a broader low-bandwidth mode.",
    defaultValue: true,
  },

  // ═══════════════════════════════════════════════════════════════════
  // AI & MODELS
  // ───────────────────────────────────────────────────────────────────
  // Plan/implement model split toggles. The model picks themselves
  // (`preferredModel`, `engineDefaultModel`) are excluded — iOS has a
  // dedicated Models picker for those.
  // ═══════════════════════════════════════════════════════════════════
  {
    // Level a NEW conversation's thinking control starts at. 'high' is the
    // desktop's opinionated default; each conversation can still be changed
    // individually from the status bar.
    key: 'defaultThinkingEffort',
    iosSurface: 'phone',
    type: 'enum',
    group: 'ai',
    label: 'Default thinking level',
    description:
      'The reasoning level new conversations start at on models that take an explicit level. Models with adaptive reasoning (Claude) choose their own depth and start on Adaptive. Each conversation can still be changed from its status bar.',
    defaultValue: 'high',
    choices: [
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra High' },
      { value: 'max', label: 'Max' },
    ],
  },
  {
    key: 'planModelSplitEnabled',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'ai',
    label: 'Plan/implement model split',
    description:
      'Automatically switch models at the plan→implement boundary. When off, the same model is used for both phases.',
    defaultValue: false,
  },
  {
    key: 'planModeModel',
    iosSurface: 'phone',
    type: 'string',
    group: 'ai',
    label: 'Plan-mode model',
    description:
      'Model to use during plan mode. Leave empty to use the conversation default.',
    defaultValue: '',
  },
  {
    key: 'implementModeModel',
    iosSurface: 'phone',
    type: 'string',
    group: 'ai',
    label: 'Implement-mode model',
    description:
      'Model to use when implementing a plan. Leave empty to use the conversation default.',
    defaultValue: '',
  },
  {
    key: 'planModeAllowedBashCommands',
    iosSurface: 'phone',
    type: 'list',
    itemType: 'string',
    group: 'ai',
    label: 'Plan mode allowed Bash commands',
    description:
      'Command prefixes allowed in plan mode (e.g. "gh", "git log", "git diff"). Token-based prefix matching: "gh" matches "gh pr view" but not "ghost". Empty disables Bash entirely in plan mode. Stored in engine.json (engine policy), not settings.json.',
    // Opinionless default: the engine ships no built-in allowlist, so an
    // unset value means Bash is blocked in plan mode. This key is stored in
    // engine.json (see ENGINE_CONFIG_BACKED_KEYS), not settings.json.
    defaultValue: [],
  },
  {
    // Default engine profile selection (Phase 3 foundation, #256).
    // Empty string = plain conversation (no extension loaded).
    // A non-empty value is an EngineProfile.id; the desktop falls back to
    // plain if the profile no longer exists. The Phase 3 UI control
    // (a profile picker in the Settings dialog AI category) is not built
    // yet — this entry projects the preference to iOS so the iOS picker
    // can set it before the desktop UI ships.
    key: 'defaultEngineProfileId',
    iosSurface: 'phone',
    type: 'string',
    group: 'ai',
    label: 'Default engine profile',
    description:
      'Engine profile used when opening a new tab. Leave empty for a plain conversation (no extension). Set to a profile ID to always open with that extension loaded.',
    defaultValue: '',
  },

  // ═══════════════════════════════════════════════════════════════════
  // APPEARANCE
  // ───────────────────────────────────────────────────────────────────
  // Visual layout + theme. Excludes terminal/editor font fields
  // (local-machine font selection has no meaning on a phone).
  // ═══════════════════════════════════════════════════════════════════
  {
    key: 'selectedTheme',
    iosSurface: 'desktop-only',
    type: 'enum',
    group: 'appearance',
    label: 'Color theme',
    description: 'Visual theme for the desktop app.',
    defaultValue: 'ion-dark',
    choices: [
      { value: 'ion-dark', label: 'Ion Dark' },
      { value: 'ion-light', label: 'Ion Light' },
      { value: 'ion-classic', label: 'Ion Classic' },
      { value: 'jarvis-hud', label: 'Jarvis HUD' },
    ],
  },
  {
    key: 'expandedUI',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'appearance',
    label: 'Full-width UI',
    description: 'Expand the desktop UI to use more horizontal space.',
    defaultValue: false,
  },
  {
    key: 'ultraWide',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'appearance',
    label: 'Ultra-wide layout',
    description: 'Shift to wider sizes for large external monitors.',
    defaultValue: false,
  },
  {
    key: 'expandToolResults',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'appearance',
    label: 'Expand tool results',
    description:
      'Render tool result blocks expanded in the conversation view. Disable to collapse them by default.',
    defaultValue: false,
  },
  {
    key: 'unifiedTurnView',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'appearance',
    label: 'Unified turn view',
    description:
      'Group tool calls into a collapsible panel and show assistant text as a continuous block, instead of interleaving tool calls with text fragments.',
    defaultValue: true,
  },
  {
    key: 'defaultTallConversation',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'appearance',
    label: 'Tall conversation tabs by default',
    description: 'Open conversation tabs in tall mode (more vertical space).',
    defaultValue: false,
  },
  {
    key: 'defaultTallTerminal',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'appearance',
    label: 'Tall terminal tabs by default',
    description: 'Open terminal tabs in tall mode.',
    defaultValue: false,
  },
  {
    key: 'closeExplorerOnFileOpen',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'appearance',
    label: 'Close explorer on file open',
    description:
      'When opening a file from the explorer, collapse the explorer panel automatically.',
    defaultValue: true,
  },
  {
    key: 'openMarkdownInPreview',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'appearance',
    label: 'Open Markdown in preview',
    description:
      'When opening a Markdown file from the explorer, open it in the preview pane instead of the editor.',
    defaultValue: true,
  },
  {
    key: 'editorWordWrap',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'appearance',
    label: 'Editor word-wrap',
    description:
      'Wrap long lines in the file editor instead of horizontal scrolling.',
    defaultValue: true,
  },
  {
    key: 'hideOnExternalLaunch',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'appearance',
    label: 'Hide window on external launch',
    description:
      'Hide the Ion window when an external app (Finder, Terminal, VS Code) is launched from a tab.',
    defaultValue: true,
  },
  {
    key: 'uiZoom',
    iosSurface: 'desktop-only',
    type: 'number',
    group: 'appearance',
    label: 'UI zoom',
    description:
      'Overall zoom level for the desktop UI. 1.0 is the default; values between 0.5 and 2.0 are supported.',
    defaultValue: 1,
    range: { min: 0.5, max: 2.0, step: 0.1 },
  },

  // ═══════════════════════════════════════════════════════════════════
  // TABS & PANELS
  // ───────────────────────────────────────────────────────────────────
  // Tab-flow and panel-behavior toggles. Includes the editable
  // tab-groups list and the three pointer keys that auto-move tabs
  // between Planning / In-Progress / Done groups (dynamic enums whose
  // choices come from the live tabGroups value).
  //
  // Excludes window-state booleans (`keepExplorerOnCollapse`, etc.) and
  // the auto-group-order which is a derived ordering, not a user-
  // editable preference.
  // ═══════════════════════════════════════════════════════════════════
  {
    key: 'inboxAutoSettleDays',
    iosSurface: 'phone',
    type: 'number',
    group: 'tabs',
    label: 'Auto-settle after (days)',
    description:
      'Optional idle-only filing. 0 disables automatic settlement. Conversations with a pending plan, user question, permission request, or background work never auto-settle.',
    defaultValue: 0,
    range: { min: 0, max: 90, step: 1 },
  },
  {
    key: 'inboxAutoSettleOnMerge',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'tabs',
    label: 'Auto-settle merged pull requests',
    description: 'Move conversations with merged pull requests to Settled. Closed pull requests always settle.',
    defaultValue: true,
  },
  {
    key: 'expandOnTabSwitch',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'tabs',
    label: 'Scroll to bottom on tab switch',
    description:
      'When switching to a tab, automatically scroll the conversation to the bottom so the latest message is visible.',
    defaultValue: true,
  },
  {
    key: 'autoGroupMovement',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'tabs',
    label: 'Auto-group movement',
    description:
      'Automatically move tabs between the Planning, In Progress, and Done groups based on permission mode and completion state.',
    defaultValue: false,
  },
  {
    key: 'tabGroupMode',
    iosSurface: 'phone',
    type: 'enum',
    group: 'tabs',
    label: 'Tab group mode',
    description:
      'Off: flat tab list. Auto: group by working directory. Manual: user-defined groups.',
    defaultValue: 'off',
    choices: [
      { value: 'off', label: 'Off (flat)' },
      { value: 'auto', label: 'Auto (by directory)' },
      { value: 'manual', label: 'Manual (custom groups)' },
    ],
  },
  {
    key: 'tabGroups',
    iosSurface: 'phone',
    type: 'list',
    group: 'tabs',
    label: 'Tab groups',
    description:
      'Custom groups for manual tab grouping. Add, rename, or reorder groups; toggle "Default Group" to control where new tabs land.',
    defaultValue: [],
    itemSchema: TAB_GROUP_ITEM_SCHEMA,
  },
  // Dynamic enums: choices are populated at snapshot time from the
  // current tabGroups value. See `projectableSchema()` in the parent
  // module for the injection logic.
  {
    key: 'planningGroupId',
    iosSurface: 'phone',
    type: 'enum',
    group: 'tabs',
    label: 'Planning group',
    description:
      'Group tabs auto-move into while in plan mode. Choose None to disable.',
    defaultValue: null,
    choices: [{ value: null, label: 'None' }],
  },
  {
    key: 'inProgressGroupId',
    iosSurface: 'phone',
    type: 'enum',
    group: 'tabs',
    label: 'In-Progress group',
    description:
      'Group tabs auto-move into when implementation starts. Choose None to disable.',
    defaultValue: null,
    choices: [{ value: null, label: 'None' }],
  },
  {
    key: 'doneGroupId',
    iosSurface: 'phone',
    type: 'enum',
    group: 'tabs',
    label: 'Done group',
    description:
      'Group tabs auto-move into after committing. Choose None to disable.',
    defaultValue: null,
    choices: [{ value: null, label: 'None' }],
  },
  {
    key: 'tabRecoveryEnabled',
    iosSurface: 'phone-critical',
    type: 'boolean',
    group: 'tabs',
    label: 'Automatic conversation recovery',
    description:
      'Automatically resume interrupted conversations after the engine restarts. Slow or silent live runs are never replayed or cancelled.',
    defaultValue: true,
  },


  // ═══════════════════════════════════════════════════════════════════
  // GIT
  // ───────────────────────────────────────────────────────────────────
  // GitOps mode, worktree behavior, commit command. Excludes
  // `worktreeBranchDefaults` (per-repo path map — local-fs concern).
  // ═══════════════════════════════════════════════════════════════════
  {
    key: 'gitOpsMode',
    iosSurface: 'phone',
    type: 'enum',
    group: 'git',
    label: 'GitOps mode',
    description:
      'Manual: no automatic git operations. Worktree: each new tab gets an isolated worktree branch.',
    defaultValue: 'manual',
    choices: [
      { value: 'manual', label: 'Manual' },
      { value: 'worktree', label: 'Worktree' },
    ],
  },
  {
    key: 'worktreeCompletionStrategy',
    iosSurface: 'phone',
    type: 'enum',
    group: 'git',
    label: 'Worktree completion strategy',
    description: 'How to integrate a worktree branch when finishing a task.',
    defaultValue: 'merge-ff',
    choices: [
      { value: 'merge-ff', label: 'Merge (--no-ff)' },
      { value: 'pr', label: 'Push + Pull Request' },
    ],
  },
  {
    key: 'worktreeSkipPrTitle',
    iosSurface: 'phone',
    type: 'boolean',
    group: 'git',
    label: 'Skip PR title dialog',
    description:
      'Always use the auto-generated branch name when opening a worktree pull request, instead of prompting.',
    defaultValue: false,
  },
  {
    key: 'commitCommand',
    iosSurface: 'desktop-only',
    type: 'string',
    group: 'git',
    label: 'Custom commit command',
    description:
      'Optional bash command to run instead of prompting the LLM for commits. Leave empty to use the default LLM-generated commit flow.',
    defaultValue: '',
  },
  {
    key: 'gitChangesTreeView',
    iosSurface: 'desktop-only',
    type: 'boolean',
    group: 'git',
    label: 'Tree view in changes panel',
    description:
      'Group changed files by directory in tree view, instead of a flat list.',
    defaultValue: false,
  },

  // ═══════════════════════════════════════════════════════════════════
  // QUICK TOOLS
  // ───────────────────────────────────────────────────────────────────
  // User-defined shell-command buttons. Editable as a list-of-records;
  // the per-record schema lives in projectable-settings-items.ts.
  // ═══════════════════════════════════════════════════════════════════
  {
    key: 'quickTools',
    iosSurface: 'phone',
    type: 'list',
    group: 'quicktools',
    label: 'Quick tools',
    description:
      'Custom shell-command buttons available from any tab. Use {cwd} and {branch} placeholders in commands.',
    defaultValue: [],
    itemSchema: QUICK_TOOL_ITEM_SCHEMA,
  },

  ...PROJECTABLE_SETTINGS_TAIL,
]
