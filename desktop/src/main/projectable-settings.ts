/**
 * Projectable settings: single source of truth for which desktop settings
 * iOS is allowed to see and write back.
 *
 * Background
 * ──────────
 * Each Ion desktop maintains its own `~/.ion/settings.json` of user
 * preferences (theme, behavior toggles, paths, model picks, etc.). iOS
 * pairs with desktops one at a time; the user expects to be able to
 * view and edit the currently-paired desktop's settings from iOS without
 * affecting other paired desktops on their network.
 *
 * Most settings in `SETTINGS_DEFAULTS` are NOT projectable to iOS for one
 * of three reasons:
 *
 *   1. They are local-machine concerns that have no meaning on a phone
 *      (`terminalFontFamily`, `gitPanelSplitRatio`, `editorFontSize`,
 *      window-state booleans like `keepExplorerOnCollapse`).
 *
 *   2. They depend on local-filesystem resources iOS does not have access
 *      to (`defaultBaseDirectory`, `recentBaseDirectories`,
 *      `worktreeBranchDefaults`).
 *
 *   3. They are user secrets or transport configuration that has its own
 *      pairing UI and must not appear here (`relayApiKey`, `pairedDevices`,
 *      `engineDefaultModel`, `preferredModel` — the model picks have a
 *      dedicated picker in the snapshot already).
 *
 * What IS projectable is a curated list of behavior toggles that make
 * sense to flip from a phone: "should the model nudge keep working?",
 * "should the tab be auto-grouped after completion?", "should the AI
 * generate titles?", etc.
 *
 * Per-desktop scoping (ADR cross-reference)
 * ─────────────────────────────────────────
 * Option (i) — iOS shows settings for the currently-connected desktop
 * only. To edit another paired desktop the user switches transports
 * first (already a one-tap action). This module is therefore concerned
 * exclusively with the values stored in *this* desktop's
 * `~/.ion/settings.json`; iOS-side per-desktop scoping is enforced by
 * the iOS UI reading from the active pairing only.
 *
 * Wire shape
 * ──────────
 * The projection rides on two wire types added to
 * `desktop/src/main/remote/protocol.ts`:
 *
 *   - `RemoteEvent.desktop_settings_snapshot { settings }` — emitted on
 *     initial pairing snapshot and on every local change to a
 *     projectable key. Carries the complete projection map as a
 *     **snapshot** (consumers REPLACE their cached view; do not merge,
 *     do not preserve absent entries — same semantics as
 *     `engine_agent_state`). Missing keys mean "this key has its default
 *     value" rather than "this key is unchanged."
 *
 *   - `RemoteCommand.set_desktop_setting { key, value }` — iOS sends
 *     this to write a setting on the currently-connected desktop. The
 *     handler validates against this module's allowlist, validates the
 *     value type matches the declared type, calls `writeSettings`, and
 *     re-emits `desktop_settings_snapshot` to all paired devices.
 *
 * Unknown keys are rejected (silent log + no write). Wrong-type values
 * are rejected. The handler does not partially-apply: either the whole
 * write succeeds or nothing changes.
 */

import { readSettings, SETTINGS_DEFAULTS } from './settings-store'
import { SETTINGS_DEFAULTS as RENDERER_SETTINGS_DEFAULTS } from '../renderer/preferences-types'

/** Allowed value types for projectable settings. */
export type ProjectableType = 'boolean' | 'string' | 'number'

/**
 * Visual grouping for the iOS Settings UI. The iOS Settings detail view
 * renders one List section per group, with the section's `Text` header
 * derived from this string. Groups are ordered top-to-bottom following
 * Apple's Settings-app convention of placing the most-flipped settings
 * first. Adding a new group is an additive change (any unknown group on
 * the iOS side renders under a fallback "Other" section).
 *
 * The grouping is metadata-only — settings can be re-grouped without a
 * wire-protocol change because the schema rides on the snapshot.
 */
export type ProjectableGroup = 'conversation' | 'workflow' | 'fileEditing' | 'appBehavior'

/**
 * One entry in the projectable-settings allowlist. The `key` matches the
 * top-level field name on the settings JSON; `type` is the value's wire
 * type; `label` and `description` are the user-facing strings the iOS
 * Settings tab renders. `group` is the visual section the iOS UI
 * places this row in.
 *
 * The `defaultValue` field is the value the desktop uses when the
 * settings file omits this key. It is duplicated here (rather than read
 * dynamically from `SETTINGS_DEFAULTS`) so the iOS UI can pre-populate
 * the row even if the snapshot is empty (e.g. a fresh pairing on a
 * never-edited desktop).
 */
export interface ProjectableSetting {
  key: string
  type: ProjectableType
  group: ProjectableGroup
  label: string
  description: string
  defaultValue: unknown
}

/**
 * The allowlist. Adding a new entry requires:
 *
 *   1. The key must exist in either `SETTINGS_DEFAULTS` (main-process) or
 *      the renderer-side `SETTINGS_DEFAULTS` map. The unit test in
 *      `projectable-settings.test.ts` enforces this so the allowlist
 *      can't drift from the canonical settings shape.
 *   2. The type must match the actual value type at runtime.
 *   3. The setting must be one that makes sense to flip from a phone
 *      (not a path, not a font, not a window-state boolean).
 *
 * Order is the order the iOS UI renders the rows — keep the most
 * commonly-flipped settings near the top.
 */
export const PROJECTABLE_SETTINGS: readonly ProjectableSetting[] = [
  // ─── Conversation ─────────────────────────────────────────────────
  // Behavior of the conversation view + the LLM-facing transcript.
  {
    key: 'enableEarlyStopContinuation',
    type: 'boolean',
    group: 'conversation',
    label: 'Early-stop continuation nudge',
    description:
      'When the model emits end_turn below the configured token budget, ask it to keep working instead of completing the run.',
    defaultValue: false,
  },
  {
    key: 'aiGeneratedTitles',
    type: 'boolean',
    group: 'conversation',
    label: 'AI-generated tab titles',
    description:
      'After the first user message, ask the model to generate a short title for the tab.',
    defaultValue: true,
  },
  {
    key: 'expandToolResults',
    type: 'boolean',
    group: 'conversation',
    label: 'Expand tool results',
    description:
      'Render tool result blocks expanded in the conversation view. Disable to collapse them by default.',
    defaultValue: false,
  },
  {
    key: 'showTodoList',
    type: 'boolean',
    group: 'conversation',
    label: 'Show TODO list panel',
    description:
      'Render the TODO list panel for tabs that have an active TodoWrite tool.',
    defaultValue: true,
  },
  // ─── Workflow ─────────────────────────────────────────────────────
  // Tab and prompt-pipeline behavior across runs.
  {
    key: 'enableClaudeCompat',
    type: 'boolean',
    group: 'workflow',
    label: 'Claude Code commands',
    description:
      'Resolve .claude/commands/*.md and .claude/skills/ templates when a slash command does not match a registered extension command. Commands in .ion/commands/ are always available.',
    defaultValue: true,
  },
  {
    key: 'bashCommandEntry',
    type: 'boolean',
    group: 'workflow',
    label: 'Bash command entry (! prefix)',
    description:
      'Allow `!command` in the prompt input to execute a shell command before the prompt is sent.',
    defaultValue: false,
  },
  {
    key: 'autoGroupMovement',
    type: 'boolean',
    group: 'workflow',
    label: 'Auto-group movement',
    description:
      'Automatically move tabs between the Planning, In Progress, and Done groups based on permission mode and completion state.',
    defaultValue: false,
  },
  {
    key: 'expandOnTabSwitch',
    type: 'boolean',
    group: 'workflow',
    label: 'Scroll to bottom on tab switch',
    description:
      'When switching to a tab, automatically scroll the conversation to the bottom so the latest message is visible.',
    defaultValue: true,
  },
  // ─── File Editing ─────────────────────────────────────────────────
  // Explorer + editor behavior on the desktop.
  {
    key: 'closeExplorerOnFileOpen',
    type: 'boolean',
    group: 'fileEditing',
    label: 'Close explorer on file open',
    description:
      'When opening a file from the explorer, collapse the explorer panel automatically.',
    defaultValue: true,
  },
  {
    key: 'openMarkdownInPreview',
    type: 'boolean',
    group: 'fileEditing',
    label: 'Open Markdown in preview',
    description:
      'When opening a Markdown file from the explorer, open it in the preview pane instead of the editor.',
    defaultValue: true,
  },
  {
    key: 'editorWordWrap',
    type: 'boolean',
    group: 'fileEditing',
    label: 'Editor word-wrap',
    description: 'Wrap long lines in the file editor.',
    defaultValue: true,
  },
  // ─── App Behavior ─────────────────────────────────────────────────
  // Desktop-wide behavior toggles that don't fit the categories above.
  {
    key: 'hideOnExternalLaunch',
    type: 'boolean',
    group: 'appBehavior',
    label: 'Hide window on external launch',
    description:
      'Hide the Ion window when an external app (e.g. terminal, VS Code) is launched from a tab.',
    defaultValue: true,
  },
]

/**
 * Ordered list of group identifiers, in the order the iOS UI renders
 * them. iOS reads this from the snapshot to drive section ordering, so
 * re-ordering or adding a group requires no iOS code change.
 */
export const PROJECTABLE_GROUP_ORDER: readonly ProjectableGroup[] = [
  'conversation',
  'workflow',
  'fileEditing',
  'appBehavior',
]

/**
 * Human-readable section titles for each group. Matches the comment
 * banners above each group block in `PROJECTABLE_SETTINGS`. Kept
 * separate from the per-entry `group` field so a group rename doesn't
 * require touching every entry.
 */
export const PROJECTABLE_GROUP_LABELS: Record<ProjectableGroup, string> = {
  conversation: 'Conversation',
  workflow: 'Workflow',
  fileEditing: 'File Editing',
  appBehavior: 'App Behavior',
}

/** Map from key to allowlist entry, for O(1) lookups. */
const PROJECTABLE_BY_KEY: Record<string, ProjectableSetting> = Object.fromEntries(
  PROJECTABLE_SETTINGS.map((s) => [s.key, s]),
)

/** Returns true when `key` is on the allowlist. */
export function isProjectableKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROJECTABLE_BY_KEY, key)
}

/**
 * Validate that `value` matches the declared type for `key`. Returns
 * `null` on success or an error message on failure. Unknown keys return
 * an error (the caller should always gate on `isProjectableKey` first).
 *
 * The handler in `command-handler.ts` uses this to reject malformed iOS
 * writes before they reach `writeSettings`. The validation is strict —
 * we don't coerce a number into a boolean or vice versa — because a
 * cross-platform contract benefits from explicit type discipline more
 * than it benefits from accommodating client mistakes.
 */
export function validateSettingValue(key: string, value: unknown): string | null {
  const entry = PROJECTABLE_BY_KEY[key]
  if (!entry) return `unknown projectable key: ${key}`
  const actualType = typeof value
  if (entry.type === 'boolean' && actualType !== 'boolean') {
    return `key ${key} expects boolean, got ${actualType}`
  }
  if (entry.type === 'string' && actualType !== 'string') {
    return `key ${key} expects string, got ${actualType}`
  }
  if (entry.type === 'number' && (actualType !== 'number' || Number.isNaN(value))) {
    return `key ${key} expects number, got ${actualType}`
  }
  return null
}

/**
 * Build the current projection map from disk. Reads `~/.ion/settings.json`
 * once, picks out every projectable key, and falls back to the entry's
 * declared default when the file omits it.
 *
 * The result is the payload of `desktop_settings_snapshot`. Snapshot
 * contract: every projectable key appears in the map; missing keys
 * indicate the projection is broken (a bug, not a meaningful "default"
 * signal). Consumers REPLACE their cached view with this payload — no
 * merging.
 */
export function projectCurrentSettings(): Record<string, unknown> {
  const saved = readSettings()
  const out: Record<string, unknown> = {}
  for (const entry of PROJECTABLE_SETTINGS) {
    if (Object.prototype.hasOwnProperty.call(saved, entry.key)) {
      out[entry.key] = saved[entry.key]
    } else {
      out[entry.key] = entry.defaultValue
    }
  }
  return out
}

/**
 * Sanity-check helper exported for the unit test: every projectable key
 * must exist in *some* `SETTINGS_DEFAULTS` map. Returns the list of
 * projectable keys that have no corresponding entry on either side.
 *
 * This is a structural assertion: if the renderer renames or removes a
 * setting, the allowlist must be updated in the same change so the
 * cross-platform contract stays coherent.
 */
export function projectableKeysWithoutDefault(): string[] {
  const main = SETTINGS_DEFAULTS as Record<string, unknown>
  const renderer = RENDERER_SETTINGS_DEFAULTS as Record<string, unknown>
  const orphans: string[] = []
  for (const entry of PROJECTABLE_SETTINGS) {
    const inMain = Object.prototype.hasOwnProperty.call(main, entry.key)
    const inRenderer = Object.prototype.hasOwnProperty.call(renderer, entry.key)
    if (!inMain && !inRenderer) orphans.push(entry.key)
  }
  return orphans
}

/**
 * Wire-format representation of a single allowlist entry. Sent alongside
 * the values in `desktop_settings_snapshot` so iOS can auto-render the
 * Settings detail view without hardcoding the schema.
 *
 * Schema-on-the-wire (rather than hardcoded on iOS) means adding a new
 * setting requires zero iOS code changes: append an entry to
 * `PROJECTABLE_SETTINGS` and iOS picks it up on the next snapshot. The
 * iOS UI renders unknown groups under a fallback "Other" section to
 * stay forward-compatible.
 */
export interface ProjectableSettingSchema {
  key: string
  type: ProjectableType
  group: ProjectableGroup
  label: string
  description: string
  defaultValue: unknown
}

/**
 * The full schema as a JSON-friendly array. iOS consumes this verbatim
 * and uses it to drive section ordering, row labels, footer text, and
 * default-value fallback when the values map omits a key.
 */
export function projectableSchema(): ProjectableSettingSchema[] {
  return PROJECTABLE_SETTINGS.map((s) => ({
    key: s.key,
    type: s.type,
    group: s.group,
    label: s.label,
    description: s.description,
    defaultValue: s.defaultValue,
  }))
}

/**
 * Ordered group descriptors for the iOS UI. Each entry pairs a group
 * identifier with its display label; iOS renders one Section per
 * group in this order.
 */
export function projectableGroups(): Array<{ id: ProjectableGroup; label: string }> {
  return PROJECTABLE_GROUP_ORDER.map((id) => ({
    id,
    label: PROJECTABLE_GROUP_LABELS[id],
  }))
}
