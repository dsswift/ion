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
 * The allowlist is generous: every user-editable preference that is
 * meaningful remotely is projected. Exclusions fall into three buckets:
 *
 *   1. Local-machine concerns that have no meaning on a phone (font
 *      sizes, split ratios, window-state booleans).
 *   2. Local-filesystem paths iOS cannot interact with
 *      (`defaultBaseDirectory`, `worktreeBranchDefaults`, …).
 *   3. Secrets / transport (`relayApiKey`, `pairedDevices`, `relayUrl`,
 *      `lanServerPort`, `remoteDisplay`) and model picks that already
 *      have a dedicated iOS picker (`engineDefaultModel`,
 *      `preferredModel`).
 *
 * The actual allowlist data lives in `projectable-settings-data.ts`;
 * shared types live in `projectable-settings-types.ts`; list-typed
 * itemSchemas live in `projectable-settings-items.ts`. This file
 * contains only the runtime API (validators, schema builders, value
 * projection) plus the group metadata.
 *
 * Per-desktop scoping
 * ───────────────────
 * iOS shows settings for the currently-connected desktop only. To edit
 * another paired desktop the user switches transports first (one tap
 * from the iOS Settings page). This module concerns itself exclusively
 * with the values stored in *this* desktop's `~/.ion/settings.json`.
 *
 * Wire shape
 * ──────────
 * Projected through two wire types in
 * `desktop/src/main/remote/protocol.ts`:
 *
 *   - `RemoteEvent.desktop_settings_snapshot { settings, schema, groups }`
 *     — emitted on initial pairing and on every projectable-key change.
 *     **Snapshot semantics** — consumers REPLACE their cached view;
 *     never merge.
 *
 *   - `RemoteCommand.set_desktop_setting { key, value }` — iOS sends
 *     this to write a setting. The handler validates against the
 *     allowlist, validates the value matches the declared type, calls
 *     `writeSettings`, and re-emits `desktop_settings_snapshot` to all
 *     paired devices.
 *
 * Forward-compat
 * ──────────────
 * New types and groups are **additive only**. Old iOS clients render
 * unknown group IDs under a fallback "Other" section and unknown type
 * IDs as a read-only string fallback. Adding a new type or group is
 * therefore wire-compatible with every shipped iOS build.
 */

import { readSettings, SETTINGS_DEFAULTS } from './settings-store'
import { SETTINGS_DEFAULTS as RENDERER_SETTINGS_DEFAULTS } from '../renderer/preferences-types'
import { PROJECTABLE_SETTINGS_DATA } from './projectable-settings-data'
import type {
  ProjectableChoice,
  ProjectableGroup,
  ProjectableSetting,
  ProjectableSettingSchema,
} from './projectable-settings-types'

// Re-export the shared types so external consumers can keep importing
// them from this canonical entry point.
export type {
  ProjectableChoice,
  ProjectableGroup,
  ProjectableRange,
  ProjectableSetting,
  ProjectableSettingSchema,
  ProjectableType,
} from './projectable-settings-types'

/**
 * The allowlist. Order = render order on iOS.
 *
 * Defined in `projectable-settings-data.ts` to keep this file under
 * the 600-line TS cap. Adding a new entry only requires touching the
 * data file (and the test, to cover any new type-specific branches).
 */
export const PROJECTABLE_SETTINGS: readonly ProjectableSetting[] = PROJECTABLE_SETTINGS_DATA

/**
 * Ordered list of group identifiers — matches the desktop SettingsDialog
 * CATEGORIES array, except:
 *   - `remote` is not projected (pairing + transport is iOS-local).
 *   - `advanced` is not projected today (its desktop subsections —
 *     Presets, Migration, Developer — are not yet meaningful as remote
 *     surfaces; adding `applyPreset` here is the obvious follow-up).
 *
 * iOS renders one section per group in this order.
 */
export const PROJECTABLE_GROUP_ORDER: readonly ProjectableGroup[] = [
  'general',
  'ai',
  'appearance',
  'tabs',
  'git',
  'quicktools',
]

/**
 * Human-readable section titles for each group. Matches the desktop
 * SettingsDialog labels verbatim.
 */
export const PROJECTABLE_GROUP_LABELS: Record<ProjectableGroup, string> = {
  general: 'General',
  ai: 'AI & Models',
  appearance: 'Appearance',
  tabs: 'Tabs & Panels',
  git: 'Git',
  quicktools: 'Quick Tools',
  advanced: 'Advanced',
}

/** Map from key to allowlist entry, for O(1) lookups. */
const PROJECTABLE_BY_KEY: Record<string, ProjectableSetting> = Object.fromEntries(
  PROJECTABLE_SETTINGS.map((s) => [s.key, s]),
)

/** Returns true when `key` is on the allowlist. */
export function isProjectableKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROJECTABLE_BY_KEY, key)
}

/** Names of the three keys whose enum choices depend on live tabGroups. */
const DYNAMIC_GROUP_ID_KEYS = new Set([
  'planningGroupId',
  'inProgressGroupId',
  'doneGroupId',
])

/** Returns true when `key` is one of the dynamic group-id enums. */
function isDynamicGroupIdKey(key: string): boolean {
  return DYNAMIC_GROUP_ID_KEYS.has(key)
}

/**
 * Validate that `value` matches the declared type for `key`. Returns
 * `null` on success or an error message on failure. Unknown keys return
 * an error (the caller should always gate on `isProjectableKey` first).
 *
 * Type rules:
 *   - boolean/string/number: strict `typeof` match. NaN is rejected
 *     even though `typeof NaN === 'number'`.
 *   - enum: value must be one of the declared `choices` (including
 *     `null` for nullable enums). For the three dynamic group-id keys
 *     we accept any string OR null at validation time — the canonical
 *     choice set depends on the live `tabGroups`, which is the
 *     projection layer's responsibility to reconcile (a write
 *     referencing a deleted group becomes "None" on the next snapshot).
 *   - list: value must be an array. When `itemType` is declared on the
 *     entry, every element is checked against that primitive type
 *     (string/number/boolean) — this is the primitive-list shape used
 *     by `string[]` preferences like `planModeAllowedBashCommands`.
 *     When `itemType` is absent, the array is accepted as-is — this is
 *     the record-list shape (`quickTools`, `tabGroups`) where per-record
 *     schema enforcement is the iOS editor's responsibility and
 *     downstream consumers tolerate forward-compat extra fields.
 */
export function validateSettingValue(key: string, value: unknown): string | null {
  const entry = PROJECTABLE_BY_KEY[key]
  if (!entry) return `unknown projectable key: ${key}`
  const actualType = typeof value
  switch (entry.type) {
    case 'boolean':
      if (actualType !== 'boolean') return `key ${key} expects boolean, got ${actualType}`
      return null
    case 'string':
      if (actualType !== 'string') return `key ${key} expects string, got ${actualType}`
      return null
    case 'number':
      if (actualType !== 'number' || Number.isNaN(value)) {
        return `key ${key} expects number, got ${actualType}`
      }
      return null
    case 'enum':
      if (value === null || actualType === 'string') {
        if (isDynamicGroupIdKey(key)) return null
        const choices = entry.choices ?? []
        const ok = choices.some((c) => c.value === value)
        return ok ? null : `key ${key} value ${JSON.stringify(value)} not in enum choices`
      }
      return `key ${key} expects enum string|null, got ${actualType}`
    case 'list':
      if (!Array.isArray(value)) return `key ${key} expects array, got ${actualType}`
      // Primitive-list: every element must match the declared itemType.
      // Record-list (itemType absent): per-element schema is not enforced
      // here; the iOS editor produces well-formed records and downstream
      // consumers tolerate forward-compat extra fields on records.
      if (entry.itemType) {
        const expected = entry.itemType
        for (let i = 0; i < value.length; i++) {
          const elem = value[i]
          const elemType = typeof elem
          if (elemType !== expected) {
            return `key ${key} expects list of ${expected}, got ${elemType} at index ${i}`
          }
        }
      }
      return null
  }
}

/**
 * Build the current projection map from disk. Reads `~/.ion/settings.json`
 * once, picks out every projectable key, and falls back to the entry's
 * declared default when the file omits it.
 *
 * Snapshot contract: every projectable key appears in the map.
 * Consumers REPLACE their cached view with this payload — no merging.
 *
 * Self-healing for dynamic group-id pointers: if `planningGroupId`,
 * `inProgressGroupId`, or `doneGroupId` references a group that no
 * longer exists in `tabGroups`, we surface it as `null` ("None") on
 * the wire. The on-disk value is left untouched so the user can rename
 * the group back; iOS just sees None until the group reappears.
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
  // Reconcile dynamic group-id pointers against the live tabGroups.
  const groups = (out.tabGroups as Array<{ id?: string }>) ?? []
  const liveIds = new Set(
    groups.map((g) => g.id).filter((id): id is string => typeof id === 'string'),
  )
  for (const key of DYNAMIC_GROUP_ID_KEYS) {
    const v = out[key]
    if (typeof v === 'string' && !liveIds.has(v)) {
      out[key] = null
    }
  }
  return out
}

/**
 * Sanity-check helper exported for the unit test: every projectable key
 * must exist in *some* `SETTINGS_DEFAULTS` map. Returns the list of
 * projectable keys that have no corresponding entry on either side.
 *
 * Structural assertion — if the renderer renames or removes a setting,
 * the allowlist must be updated in the same change so the cross-
 * platform contract stays coherent.
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
 * Build the schema array as it appears on the wire.
 *
 * Dynamic-choice injection: for the three group-id keys
 * (`planningGroupId`, `inProgressGroupId`, `doneGroupId`), we replace
 * the placeholder `[{ value: null, label: 'None' }]` with the current
 * list of tab groups (read from `settings.json`) prefixed by None. This
 * gives iOS a live picker that reflects the user's groups without
 * needing a separate wire round-trip.
 *
 * The recursion through `itemSchema` is shallow: list-typed entries
 * declare nested schemas, but those nested schemas are not themselves
 * dynamic today.
 */
export function projectableSchema(): ProjectableSettingSchema[] {
  const saved = readSettings()
  const groups = (saved.tabGroups as Array<{ id?: string; label?: string }>) ?? []
  const groupChoices: ProjectableChoice[] = [
    { value: null, label: 'None' },
    ...groups
      .filter((g) => typeof g.id === 'string' && typeof g.label === 'string')
      .map((g) => ({ value: g.id as string, label: g.label as string })),
  ]
  return PROJECTABLE_SETTINGS.map((s) => {
    const base: ProjectableSettingSchema = {
      key: s.key,
      type: s.type,
      group: s.group,
      label: s.label,
      description: s.description,
      defaultValue: s.defaultValue,
    }
    if (isDynamicGroupIdKey(s.key)) {
      base.choices = groupChoices
    } else if (s.choices) {
      base.choices = s.choices
    }
    if (s.range) base.range = s.range
    if (s.itemSchema) base.itemSchema = s.itemSchema.map(itemToSchema)
    if (s.itemType) base.itemType = s.itemType
    return base
  })
}

/**
 * Convert one `ProjectableSetting` into its wire-format schema shape.
 * Used to convert nested `itemSchema` entries on list-typed fields.
 * Mirrors the structure of `projectableSchema` but skips the dynamic-
 * choices injection (item-level fields are not dynamic today).
 */
function itemToSchema(s: ProjectableSetting): ProjectableSettingSchema {
  const out: ProjectableSettingSchema = {
    key: s.key,
    type: s.type,
    group: s.group,
    label: s.label,
    description: s.description,
    defaultValue: s.defaultValue,
  }
  if (s.choices) out.choices = s.choices
  if (s.range) out.range = s.range
  if (s.itemSchema) out.itemSchema = s.itemSchema.map(itemToSchema)
  if (s.itemType) out.itemType = s.itemType
  return out
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
