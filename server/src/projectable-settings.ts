/**
 * Projectable settings: single source of truth for which settings a thin
 * client (the phone) is allowed to see and write back on this server.
 *
 * Background
 * ──────────
 * A server keeps its Environment settings in its `settings.json` and each
 * person's Account settings in that person's overlay. The phone renders
 * the projection of both for whoever it is signed in as.
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
 * Per-server scoping
 * ──────────────────
 * The phone shows settings for the server it is connected to only. This
 * module concerns itself exclusively with the values stored on *this*
 * server.
 *
 * Wire shape
 * ──────────
 *   - `desktop_settings_snapshot { settings, schema, groups, pages, … }`
 *     (`server/src/remote/protocol.ts`), built by
 *     `buildDesktopSettingsSnapshot` in `settings-broadcast.ts` — sent on
 *     first sync and on every projectable-key change. Each schema entry
 *     names the settings page and section showing it, and `pages` lists
 *     those pages in the order Studio shows them
 *     (`@ion/shared/settings-taxonomy`). **Snapshot semantics** — consumers
 *     REPLACE their cached view; never merge.
 *
 *   - The `settings.setProjectable` Studio action writes one key
 *     (`applyProjectableSetting`, `remote/handlers/desktop-settings.ts`):
 *     it validates the key and value against this allowlist, routes the
 *     write by the key's registry scope, and re-emits the snapshot.
 *
 * Forward-compat
 * ──────────────
 * New types and groups are **additive only**. Old iOS clients render
 * unknown group IDs under a fallback "Other" section and unknown type
 * IDs as a read-only string fallback. Adding a new type or group is
 * therefore wire-compatible with every shipped iOS build.
 */

import { currentEnterprisePolicy } from './enterprise-policy-source'
import { sealedSettingKeys } from './protocol/settings-seal'
import { deriveEnterpriseSettingsEditsPolicy } from '@ion/shared/enterprise-settings-edits-policy'
import { SETTINGS_DEFAULTS } from './persistence/settings-store'
import { readEffectiveSettings } from './persistence/effective-settings'
import { settingScope } from '@ion/shared/settings-registry'
import { SETTINGS_DEFAULTS as RENDERER_SETTINGS_DEFAULTS } from './preferences-types'
import {
  PROJECTABLE_SETTINGS_DATA,
  ENGINE_CONFIG_BACKED_KEYS,
} from './projectable-settings-data'
import { readPlanBashAllowlist } from './plan-bash-allowlist-store'
import { isKnownDesktopThemeId } from './theme-packs'
import { BUILTIN_THEME_IDS } from '@ion/shared/theme-pack-types'
import { SETTINGS_TAXONOMY, type SettingsPageScope } from '@ion/shared/settings-taxonomy'
import type {
  ProjectableGroup,
  ProjectableItemField,
  ProjectableSetting,
  ProjectableSettingSchema,
} from './projectable-settings-types'

// Re-export the shared types so external consumers can keep importing
// them from this canonical entry point.
export type {
  ProjectableChoice,
  ProjectableGroup,
  ProjectableItemField,
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
export const PROJECTABLE_SETTINGS: readonly ProjectableSetting[] =
  PROJECTABLE_SETTINGS_DATA

const VISIBLE = PROJECTABLE_SETTINGS.filter(
  (s) => s.iosSurface !== 'desktop-only',
)
const VISIBLE_GROUPS = new Set(VISIBLE.map((s) => s.group))

/**
 * The settings groups the projected keys belong to, in the order a client
 * that predates `pages` renders them, one section per group. A newer
 * client lays the projection out by each entry's `page` and `section`.
 */
export const PROJECTABLE_GROUP_ORDER: readonly ProjectableGroup[] = [
  'general',
  'ai',
  'appearance',
  'tabs',
  'git',
  'quicktools',
  'notifications',
  'advanced',
]

/** Section titles for each group, for clients that render by group. */
export const PROJECTABLE_GROUP_LABELS: Record<ProjectableGroup, string> = {
  general: 'General',
  ai: 'AI & Models',
  appearance: 'Appearance',
  tabs: 'Tabs & Panels',
  git: 'Git',
  quicktools: 'Quick Tools',
  notifications: 'Notifications',
  advanced: 'Advanced',
}

/** Map from key to allowlist entry, for O(1) lookups. */
const PROJECTABLE_BY_KEY: Record<string, ProjectableSetting> =
  Object.fromEntries(PROJECTABLE_SETTINGS.map((s) => [s.key, s]))

/** Returns true when `key` is on the allowlist. */
export function isProjectableKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROJECTABLE_BY_KEY, key)
}

/**
 * Validate that `value` matches the declared type for `key`. Returns
 * `null` on success or an error message on failure. Unknown keys return
 * an error (the caller should always gate on `isProjectableKey` first).
 *
 * Type rules:
 *   - boolean/string/number: strict `typeof` match. Non-finite numeric
 *     values are rejected even though `typeof NaN === 'number'`. Declared
 *     numeric ranges are enforced at this write boundary.
 *   - enum: value must be one of the declared `choices` (including
 *     `null` for nullable enums). `selectedTheme` validates against the
 *     live theme registry instead, so an installed theme pack's id is
 *     accepted.
 *   - list: value must be an array. When `itemType` is declared on the
 *     entry, every element is checked against that primitive type
 *     (string/number/boolean) — this is the primitive-list shape used
 *     by `string[]` preferences like `planModeAllowedBashCommands`.
 *     When `itemType` is absent, the array is accepted as-is — this is
 *     the record-list shape (`quickTools`) where per-record
 *     schema enforcement is the iOS editor's responsibility and
 *     downstream consumers tolerate forward-compat extra fields.
 */
export function validateSettingValue(
  key: string,
  value: unknown,
): string | null {
  const entry = PROJECTABLE_BY_KEY[key]
  if (!entry) return `unknown projectable key: ${key}`
  const actualType = typeof value
  switch (entry.type) {
    case 'boolean':
      if (actualType !== 'boolean')
        return `key ${key} expects boolean, got ${actualType}`
      return null
    case 'string':
      if (actualType !== 'string')
        return `key ${key} expects string, got ${actualType}`
      return null
    case 'number':
      if (actualType !== 'number' || !Number.isFinite(value)) {
        return `key ${key} expects finite number, got ${actualType}`
      }
      const numericValue = value as number
      if (entry.range && (numericValue < entry.range.min || numericValue > entry.range.max)) {
        return `key ${key} must be between ${entry.range.min} and ${entry.range.max}`
      }
      return null
    case 'enum':
      if (value === null || actualType === 'string') {
        // selectedTheme's canonical choice set is the live theme registry:
        // built-ins plus installed theme packs that carry a desktop
        // component. The static choices on the data entry cover only the
        // built-ins, so a custom-pack id must validate against the registry
        // — otherwise iOS writes of installed custom themes are silently
        // rejected.
        if (key === 'selectedTheme') {
          if (
            typeof value === 'string' &&
            isKnownDesktopThemeId(value, BUILTIN_THEME_IDS)
          )
            return null
          return `key ${key} value ${JSON.stringify(value)} is not an installed theme id`
        }
        const choices = entry.choices ?? []
        const ok = choices.some((c) => c.value === value)
        return ok
          ? null
          : `key ${key} value ${JSON.stringify(value)} not in enum choices`
      }
      return `key ${key} expects enum string|null, got ${actualType}`
    case 'list':
      if (!Array.isArray(value))
        return `key ${key} expects array, got ${actualType}`
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
 */
/**
 * `subject` is whose values to project. An Account setting lives in that
 * person's overlay, so projecting the Environment document alone showed a
 * phone values its owner had already replaced, and never showed a change the
 * phone itself had made.
 */
export function projectCurrentSettings(subject?: string | null): Record<string, unknown> {
  const saved = readEffectiveSettings(subject)
  const out: Record<string, unknown> = {}
  for (const entry of VISIBLE) {
    // Engine-config-backed keys live in engine.json, not settings.json — read
    // them from their canonical store so iOS sees the real engine policy.
    if (ENGINE_CONFIG_BACKED_KEYS.has(entry.key)) {
      out[entry.key] = readPlanBashAllowlist()
    } else if (Object.prototype.hasOwnProperty.call(saved, entry.key)) {
      out[entry.key] = saved[entry.key]
    } else {
      out[entry.key] = entry.defaultValue
    }
  }
  // A sealed key shows the organization's value, not the saved one: the
  // saved value is what the seal overrides.
  const seal = deriveEnterpriseSettingsEditsPolicy(currentEnterprisePolicy())
  if (seal && Object.prototype.hasOwnProperty.call(out, 'allowSettingsEdits')) out.allowSettingsEdits = seal.allowed
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
    // Engine-config-backed keys have their default in the projectable entry +
    // engine.json, not in either SETTINGS_DEFAULTS map — exclude them from
    // the structural orphan check.
    if (ENGINE_CONFIG_BACKED_KEYS.has(entry.key)) continue
    const inMain = Object.prototype.hasOwnProperty.call(main, entry.key)
    const inRenderer = Object.prototype.hasOwnProperty.call(renderer, entry.key)
    if (!inMain && !inRenderer) orphans.push(entry.key)
  }
  return orphans
}

/**
 * Projectable keys whose declared `defaultValue` disagrees with the default
 * the desktop actually ships for that key.
 *
 * The entry's `defaultValue` is what iOS renders as "Default" on the row, and
 * it is written by hand next to the key. Nothing forces it to track the real
 * default, so changing the ship default in SETTINGS_DEFAULTS leaves iOS
 * advertising the old one — a row that quietly lies about what a fresh install
 * does. Engine-config-backed keys are excluded for the same reason as in
 * `projectableKeysWithoutDefault`: their default lives in engine.json, and the
 * entry's `defaultValue` is the only record of it.
 */
export function projectableKeysWithDriftedDefault(): string[] {
  const main = SETTINGS_DEFAULTS as Record<string, unknown>
  const renderer = RENDERER_SETTINGS_DEFAULTS as Record<string, unknown>
  const drifted: string[] = []
  for (const entry of PROJECTABLE_SETTINGS) {
    if (ENGINE_CONFIG_BACKED_KEYS.has(entry.key)) continue
    const shipped = Object.prototype.hasOwnProperty.call(main, entry.key)
      ? main[entry.key]
      : Object.prototype.hasOwnProperty.call(renderer, entry.key)
        ? renderer[entry.key]
        : undefined
    if (shipped === undefined) continue // orphan; the other check reports it
    if (JSON.stringify(shipped) !== JSON.stringify(entry.defaultValue)) {
      drifted.push(`${entry.key} (ships ${JSON.stringify(shipped)}, declares ${JSON.stringify(entry.defaultValue)})`)
    }
  }
  return drifted
}

/**
 * Build the schema array as it appears on the wire. The schema is the same
 * for every person; a sealed key is marked so a client renders it read-only.
 *
 * The recursion through `itemSchema` is shallow: list-typed entries
 * declare nested schemas, but those nested schemas carry no scope or seal.
 */
export function projectableSchema(): ProjectableSettingSchema[] {
  const sealed = new Set(sealedSettingKeys(currentEnterprisePolicy()))
  return VISIBLE.map((s) => {
    const base: ProjectableSettingSchema = {
      key: s.key,
      type: s.type,
      group: s.group,
      page: s.page,
      section: s.section,
      label: s.label,
      description: s.description,
      defaultValue: s.defaultValue,
      scope: settingScope(s.key),
    }
    if (sealed.has(s.key)) base.sealed = true
    if (s.choices) base.choices = s.choices
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
function itemToSchema(s: ProjectableItemField): ProjectableSettingSchema {
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
export function projectableGroups(): Array<{
  id: ProjectableGroup
  label: string
}> {
  return PROJECTABLE_GROUP_ORDER.filter((id) => VISIBLE_GROUPS.has(id)).map(
    (id) => ({
      id,
      label: PROJECTABLE_GROUP_LABELS[id],
    }),
  )
}

/** One settings page as the snapshot lists it. */
export interface ProjectablePage {
  id: string
  label: string
  scope: SettingsPageScope
  sections: Array<{ id: string; label: string }>
}

const PAGES_WITH_PROJECTED_KEYS = new Set(VISIBLE.map((s) => s.page))

/**
 * The settings pages a client renders the projection under, in Studio's
 * order: every page that shows a projected key, and every server page (a
 * server page's other sections are administered through their own actions).
 * Each page lists all its sections.
 */
export function projectablePages(): ProjectablePage[] {
  return SETTINGS_TAXONOMY
    .filter((page) => page.scope === 'server' || PAGES_WITH_PROJECTED_KEYS.has(page.id))
    .map((page) => ({
      id: page.id,
      label: page.label,
      scope: page.scope,
      sections: page.sections.map((s) => ({ id: s.id, label: s.label })),
    }))
}
