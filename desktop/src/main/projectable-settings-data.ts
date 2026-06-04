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
    type: 'boolean',
    group: 'general',
    label: 'Bash command entry (! prefix)',
    description: 'Allow `!command` in the prompt input to execute a shell command before the prompt is sent.',
    defaultValue: false,
  },
  {
    key: 'allowSettingsEdits',
    type: 'boolean',
    group: 'general',
    label: 'Allow settings edits by the agent',
    description: 'Show an approval card when the agent tries to edit its own settings files, instead of blocking outright.',
    defaultValue: false,
  },
  {
    key: 'enableClaudeCompat',
    type: 'boolean',
    group: 'general',
    label: 'Claude Code commands',
    description: 'Resolve .claude/commands/*.md and .claude/skills/ templates when a slash command does not match a registered extension command. Commands in .ion/commands/ are always available.',
    defaultValue: true,
  },
  {
    key: 'enableEarlyStopContinuation',
    type: 'boolean',
    group: 'general',
    label: 'Early-stop continuation nudge',
    description: 'When the model emits end_turn below the configured token budget, ask it to keep working instead of completing the run.',
    defaultValue: false,
  },
  {
    key: 'soundEnabled',
    type: 'boolean',
    group: 'general',
    label: 'Notification sound',
    description: 'Play a sound when a task completes on the desktop.',
    defaultValue: true,
  },
  {
    key: 'showTodoList',
    type: 'boolean',
    group: 'general',
    label: 'Show TODO list panel',
    description: 'Render the TODO list panel for tabs that have an active TodoWrite tool.',
    defaultValue: true,
  },
  {
    key: 'agentPanelDefaultOpen',
    type: 'boolean',
    group: 'general',
    label: 'Agent panel open by default',
    description: 'Automatically expand the agent panel when agents are dispatched. Disable to keep it collapsed until manually opened.',
    defaultValue: true,
  },
  {
    key: 'agentDetailPopup',
    type: 'boolean',
    group: 'general',
    label: 'Agent detail popup',
    description: 'Click an agent row to open a floating detail panel instead of expanding inline.',
    defaultValue: true,
  },
  {
    key: 'aiGeneratedTitles',
    type: 'boolean',
    group: 'general',
    label: 'AI-generated tab titles',
    description: 'After the first user message, ask the model to generate a short title for the tab.',
    defaultValue: true,
  },
  {
    key: 'showImplementClearContext',
    type: 'boolean',
    group: 'general',
    label: 'Show "Implement, clear context" button',
    description: 'Reveal a second button on the plan-approval card that starts a fresh conversation for the implementation phase. The regular Implement button always preserves the conversation. Use /clear to clear context manually at any time.',
    defaultValue: false,
  },
  {
    key: 'preferredOpenWith',
    type: 'enum',
    group: 'general',
    label: 'Preferred external editor',
    description: 'Default application when opening files externally.',
    defaultValue: 'cli',
    choices: [
      { value: 'cli', label: 'Terminal (CLI)' },
      { value: 'vscode', label: 'VS Code' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════
  // AI & MODELS
  // ───────────────────────────────────────────────────────────────────
  // Plan/implement model split toggles. The model picks themselves
  // (`preferredModel`, `engineDefaultModel`) are excluded — iOS has a
  // dedicated Models picker for those.
  // ═══════════════════════════════════════════════════════════════════
  {
    key: 'planModelSplitEnabled',
    type: 'boolean',
    group: 'ai',
    label: 'Plan/implement model split',
    description: 'Automatically switch models at the plan→implement boundary. When off, the same model is used for both phases.',
    defaultValue: false,
  },
  {
    key: 'planModeModel',
    type: 'string',
    group: 'ai',
    label: 'Plan-mode model',
    description: 'Model to use during plan mode. Leave empty to use the conversation default.',
    defaultValue: '',
  },
  {
    key: 'implementModeModel',
    type: 'string',
    group: 'ai',
    label: 'Implement-mode model',
    description: 'Model to use when implementing a plan. Leave empty to use the conversation default.',
    defaultValue: '',
  },
  {
    key: 'planModeAllowedBashCommands',
    type: 'list',
    itemType: 'string',
    group: 'ai',
    label: 'Plan mode allowed Bash commands',
    description: 'Command prefixes allowed in plan mode (e.g. "gh", "git log", "git diff"). Token-based prefix matching: "gh" matches "gh pr view" but not "ghost". Empty disables Bash entirely in plan mode.',
    defaultValue: ['gh'],
  },

  // ═══════════════════════════════════════════════════════════════════
  // APPEARANCE
  // ───────────────────────────────────────────────────────────────────
  // Visual layout + theme. Excludes terminal/editor font fields
  // (local-machine font selection has no meaning on a phone).
  // ═══════════════════════════════════════════════════════════════════
  {
    key: 'themeMode',
    type: 'enum',
    group: 'appearance',
    label: 'Theme mode',
    description: 'System follows the OS, Light/Dark override it.',
    defaultValue: 'dark',
    choices: [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
  },
  {
    key: 'expandedUI',
    type: 'boolean',
    group: 'appearance',
    label: 'Full-width UI',
    description: 'Expand the desktop UI to use more horizontal space.',
    defaultValue: false,
  },
  {
    key: 'ultraWide',
    type: 'boolean',
    group: 'appearance',
    label: 'Ultra-wide layout',
    description: 'Shift to wider sizes for large external monitors.',
    defaultValue: false,
  },
  {
    key: 'expandToolResults',
    type: 'boolean',
    group: 'appearance',
    label: 'Expand tool results',
    description: 'Render tool result blocks expanded in the conversation view. Disable to collapse them by default.',
    defaultValue: false,
  },
  {
    key: 'unifiedTurnView',
    type: 'boolean',
    group: 'appearance',
    label: 'Unified turn view',
    description: 'Group tool calls into a collapsible panel and show assistant text as a continuous block, instead of interleaving tool calls with text fragments.',
    defaultValue: true,
  },
  {
    key: 'defaultTallConversation',
    type: 'boolean',
    group: 'appearance',
    label: 'Tall conversation tabs by default',
    description: 'Open conversation tabs in tall mode (more vertical space).',
    defaultValue: false,
  },
  {
    key: 'defaultTallTerminal',
    type: 'boolean',
    group: 'appearance',
    label: 'Tall terminal tabs by default',
    description: 'Open terminal tabs in tall mode.',
    defaultValue: false,
  },
  {
    key: 'defaultTallEngine',
    type: 'boolean',
    group: 'appearance',
    label: 'Tall engine tabs by default',
    description: 'Open engine tabs in tall mode.',
    defaultValue: false,
  },
  {
    key: 'closeExplorerOnFileOpen',
    type: 'boolean',
    group: 'appearance',
    label: 'Close explorer on file open',
    description: 'When opening a file from the explorer, collapse the explorer panel automatically.',
    defaultValue: true,
  },
  {
    key: 'openMarkdownInPreview',
    type: 'boolean',
    group: 'appearance',
    label: 'Open Markdown in preview',
    description: 'When opening a Markdown file from the explorer, open it in the preview pane instead of the editor.',
    defaultValue: true,
  },
  {
    key: 'editorWordWrap',
    type: 'boolean',
    group: 'appearance',
    label: 'Editor word-wrap',
    description: 'Wrap long lines in the file editor instead of horizontal scrolling.',
    defaultValue: true,
  },
  {
    key: 'hideOnExternalLaunch',
    type: 'boolean',
    group: 'appearance',
    label: 'Hide window on external launch',
    description: 'Hide the Ion window when an external app (Finder, Terminal, VS Code) is launched from a tab.',
    defaultValue: true,
  },
  {
    key: 'uiZoom',
    type: 'number',
    group: 'appearance',
    label: 'UI zoom',
    description: 'Overall zoom level for the desktop UI. 1.0 is the default; values between 0.5 and 2.0 are supported.',
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
    key: 'expandOnTabSwitch',
    type: 'boolean',
    group: 'tabs',
    label: 'Scroll to bottom on tab switch',
    description: 'When switching to a tab, automatically scroll the conversation to the bottom so the latest message is visible.',
    defaultValue: true,
  },
  {
    key: 'autoGroupMovement',
    type: 'boolean',
    group: 'tabs',
    label: 'Auto-group movement',
    description: 'Automatically move tabs between the Planning, In Progress, and Done groups based on permission mode and completion state.',
    defaultValue: false,
  },
  {
    key: 'tabGroupMode',
    type: 'enum',
    group: 'tabs',
    label: 'Tab group mode',
    description: 'Off: flat tab list. Auto: group by working directory. Manual: user-defined groups.',
    defaultValue: 'off',
    choices: [
      { value: 'off', label: 'Off (flat)' },
      { value: 'auto', label: 'Auto (by directory)' },
      { value: 'manual', label: 'Manual (custom groups)' },
    ],
  },
  {
    key: 'tabGroups',
    type: 'list',
    group: 'tabs',
    label: 'Tab groups',
    description: 'Custom groups for manual tab grouping. Add, rename, or reorder groups; toggle "Default Group" to control where new tabs land.',
    defaultValue: [],
    itemSchema: TAB_GROUP_ITEM_SCHEMA,
  },
  // Dynamic enums: choices are populated at snapshot time from the
  // current tabGroups value. See `projectableSchema()` in the parent
  // module for the injection logic.
  {
    key: 'planningGroupId',
    type: 'enum',
    group: 'tabs',
    label: 'Planning group',
    description: 'Group tabs auto-move into while in plan mode. Choose None to disable.',
    defaultValue: null,
    choices: [{ value: null, label: 'None' }],
  },
  {
    key: 'inProgressGroupId',
    type: 'enum',
    group: 'tabs',
    label: 'In-Progress group',
    description: 'Group tabs auto-move into when implementation starts. Choose None to disable.',
    defaultValue: null,
    choices: [{ value: null, label: 'None' }],
  },
  {
    key: 'doneGroupId',
    type: 'enum',
    group: 'tabs',
    label: 'Done group',
    description: 'Group tabs auto-move into after committing. Choose None to disable.',
    defaultValue: null,
    choices: [{ value: null, label: 'None' }],
  },
  {
    key: 'tabRecoveryEnabled',
    type: 'boolean',
    group: 'tabs',
    label: 'Auto-recover stuck tabs',
    description: 'Automatically attempt to recover tabs that appear stuck (no engine events for a period).',
    defaultValue: true,
  },
  {
    key: 'tabRecoveryTimeoutSec',
    type: 'number',
    group: 'tabs',
    label: 'Tab recovery timeout (sec)',
    description: 'Idle threshold in seconds before a stuck tab is force-recovered. Only applies when auto-recovery is enabled.',
    defaultValue: 120,
    range: { min: 10, max: 600, step: 10 },
  },

  // ═══════════════════════════════════════════════════════════════════
  // GIT
  // ───────────────────────────────────────────────────────────────────
  // GitOps mode, worktree behavior, commit command. Excludes
  // `worktreeBranchDefaults` (per-repo path map — local-fs concern).
  // ═══════════════════════════════════════════════════════════════════
  {
    key: 'gitOpsMode',
    type: 'enum',
    group: 'git',
    label: 'GitOps mode',
    description: 'Manual: no automatic git operations. Worktree: each new tab gets an isolated worktree branch.',
    defaultValue: 'manual',
    choices: [
      { value: 'manual', label: 'Manual' },
      { value: 'worktree', label: 'Worktree' },
    ],
  },
  {
    key: 'worktreeCompletionStrategy',
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
    type: 'boolean',
    group: 'git',
    label: 'Skip PR title dialog',
    description: 'Always use the auto-generated branch name when opening a worktree pull request, instead of prompting.',
    defaultValue: false,
  },
  {
    key: 'commitCommand',
    type: 'string',
    group: 'git',
    label: 'Custom commit command',
    description: 'Optional bash command to run instead of prompting the LLM for commits. Leave empty to use the default LLM-generated commit flow.',
    defaultValue: '',
  },
  {
    key: 'gitChangesTreeView',
    type: 'boolean',
    group: 'git',
    label: 'Tree view in changes panel',
    description: 'Group changed files by directory in tree view, instead of a flat list.',
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
    type: 'list',
    group: 'quicktools',
    label: 'Quick tools',
    description: 'Custom shell-command buttons available from any tab. Use {cwd} and {branch} placeholders in commands.',
    defaultValue: [],
    itemSchema: QUICK_TOOL_ITEM_SCHEMA,
  },
]
