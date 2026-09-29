/**
 * Shared types for the projectable-settings system.
 *
 * Pulled into its own file so that `projectable-settings-data.ts` and
 * `projectable-settings-items.ts` can import the interfaces without
 * pulling in the parent module's runtime code (which would create a
 * circular import: parent → data → parent). This file is types-only.
 *
 * All semantic documentation lives on the type declarations themselves.
 * The parent module (`projectable-settings.ts`) re-exports these types
 * so external consumers can continue to import them from the canonical
 * entry point.
 */

import type { SettingsPageId, SettingsSectionId } from '@ion/shared/settings-taxonomy'

/**
 * Allowed value types for projectable settings.
 *
 * `'enum'` — a fixed or dynamic set of string (or null) choices. The
 * `choices` field on the entry enumerates them. Used by string-enum
 * preferences (`gitOpsMode`, `selectedTheme`, …).
 *
 * `'list'` — an array of records OR an array of primitives. The shape
 * is disambiguated by `itemType` vs. `itemSchema`:
 *
 *   - Record-list (`itemSchema` set, `itemType` absent): iOS renders an
 *     Apple-style list with NavigationLink rows; tapping a row pushes a
 *     per-record editor. Used by `quickTools`.
 *
 *   - Primitive-list (`itemType` set, `itemSchema` absent): iOS renders
 *     a flat editable list of primitive values inline — TextField per
 *     row for strings, Stepper per row for numbers, Toggle per row for
 *     booleans. No per-record editor. Used by `string[]` preferences
 *     like `planModeAllowedBashCommands`.
 *
 * In both shapes the snapshot semantics are the same: every mutation
 * (add/edit/delete/reorder) ships the entire updated array back as the
 * value and the desktop replaces the whole array. No partial-update
 * protocol exists.
 *
 * Forward-compat note: older iOS builds that don't know about
 * `itemType` see a `list`-typed entry with no `itemSchema` and fall
 * through to a read-only "Other" / unsupported fallback. New
 * desktops talking to old iOS therefore degrade gracefully; new iOS
 * talking to old desktops sees the schema as before.
 */
export type ProjectableType = 'boolean' | 'string' | 'number' | 'enum' | 'list'

/**
 * Allowed item types for a primitive `'list'` (one whose elements are
 * scalars, not records). Distinct from `ProjectableType` because
 * record-of-records and list-of-lists are not supported today — the
 * iOS primitive-list editor only renders flat scalar rows.
 *
 * Adding `'enum'` here would require teaching the editor to render a
 * Picker per row; intentionally deferred until a real use case exists.
 */
export type ProjectablePrimitiveItemType = 'string' | 'number' | 'boolean'

/**
 * The settings group (`@ion/shared/settings-classification`) a projected
 * key belongs to: what enterprise policy hides it by. Clients that predate
 * `page`/`section` render one section per group, in
 * `PROJECTABLE_GROUP_ORDER`. Adding a group is additive (older clients fall
 * back to "Other").
 */
export type ProjectableGroup =
  | 'general'
  | 'ai'
  | 'appearance'
  | 'tabs'
  | 'git'
  | 'quicktools'
  | 'notifications'
  | 'advanced'

/**
 * One choice in an enum-typed projectable setting. `value` is the
 * underlying JSON value written back to disk; `label` is the
 * human-readable string the iOS picker displays.
 *
 * `value: null` is supported and represents the "None / disabled" choice
 * for nullable enums. The iOS picker renders the label as-is; the wire
 * value is JSON null.
 */
export interface ProjectableChoice {
  value: string | null
  label: string
}

/**
 * Optional numeric bounds for `'number'`-typed entries. When present,
 * iOS uses these to clamp the stepper and pick a sensible step size.
 * Absent → iOS falls back to a permissive `0..10000` step-1 default
 * (legacy behavior).
 */
export interface ProjectableRange {
  min: number
  max: number
  step: number
}

/**
 * One entry in the projectable-settings allowlist.
 *
 * `key` matches the top-level field name on the settings JSON; `type` is
 * the value's wire type; `label` and `description` are the user-facing
 * strings the iOS Settings tab renders. `group` is the visual section.
 *
 * `defaultValue` is duplicated from `SETTINGS_DEFAULTS` so the iOS UI
 * can pre-populate the row even if the snapshot is empty (e.g. a fresh
 * pairing on a never-edited desktop). Type unrestricted because list
 * defaults are arrays and enum defaults can be `null`.
 *
 * `choices`, `range`, `itemSchema`, and `itemType` are optional per-type
 * extensions. They are required when their corresponding `type` is set
 * and otherwise ignored. `'list'` requires exactly one of `itemSchema`
 * (record-list) or `itemType` (primitive-list) — never both, never
 * neither. The validator enforces this implicitly: an itemType-less
 * list with no itemSchema accepts any array, which is the legacy
 * behavior preserved for backward compat.
 */
export type IosSurface = 'phone-critical' | 'phone' | 'desktop-only'

export interface ProjectableSetting {
  key: string
  type: ProjectableType
  group: ProjectableGroup
  /** The settings page showing this key (`@ion/shared/settings-taxonomy`). */
  page: SettingsPageId
  /** The section of `page` showing this key. */
  section: SettingsSectionId
  label: string
  description: string
  defaultValue: unknown
  /** Source-only classifier deciding whether iOS receives this setting. */
  iosSurface: IosSurface
  /** For `'enum'` only — the available choices. */
  choices?: ProjectableChoice[]
  /** For `'number'` only — bounds + step. */
  range?: ProjectableRange
  /** For record-list `'list'` only — per-field metadata for one record. */
  itemSchema?: ProjectableItemField[]
  /** For primitive-list `'list'` only — type of each scalar element. */
  itemType?: ProjectablePrimitiveItemType
}

/** Surface-free field descriptor for records inside a list setting. */
export type ProjectableItemField = Omit<
  ProjectableSetting,
  'iosSurface' | 'itemSchema' | 'page' | 'section'
> & {
  itemSchema?: ProjectableItemField[]
}

/**
 * Wire-format representation of a single allowlist entry. Sent alongside
 * the values in `desktop_settings_snapshot` so iOS can auto-render the
 * Settings detail view without hardcoding the schema.
 *
 * Distinct from `ProjectableSetting` only structurally — the schema
 * shape is what crosses the wire, while `ProjectableSetting` is the
 * source-of-truth type used by the allowlist definition. They are
 * intentionally distinct: source-only fields such as `iosSurface` stay
 * on `ProjectableSetting` and never leak onto the wire.
 */
export interface ProjectableSettingSchema {
  key: string
  type: ProjectableType
  group: ProjectableGroup
  /** The settings page showing this key. Absent on a nested `itemSchema` field. */
  page?: SettingsPageId
  /** The section of `page` showing this key. Absent on a nested `itemSchema` field. */
  section?: SettingsSectionId
  label: string
  description: string
  defaultValue: unknown
  choices?: ProjectableChoice[]
  range?: ProjectableRange
  itemSchema?: ProjectableSettingSchema[]
  itemType?: ProjectablePrimitiveItemType
  /**
   * The organization has sealed this key to the value shown. A client renders
   * it read-only for everyone; the server refuses every save of it.
   */
  sealed?: boolean
  /**
   * The key's scope from the settings registry. A client renders an
   * `environment` key read-only unless the snapshot says it may manage the
   * Environment. Absent on a nested `itemSchema` field, which has no scope of
   * its own.
   */
  scope?: import('@ion/shared/settings-registry').SettingScope
}
