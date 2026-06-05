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

/**
 * Allowed value types for projectable settings.
 *
 * `'enum'` — a fixed or dynamic set of string (or null) choices. The
 * `choices` field on the entry enumerates them. Used by string-enum
 * preferences (`gitOpsMode`, `themeMode`, …) and by the three tab-group
 * pointer keys (`inProgressGroupId`, `doneGroupId`, `planningGroupId`)
 * whose choices are derived dynamically from the user's current
 * `tabGroups` at snapshot time.
 *
 * `'list'` — an array of records OR an array of primitives. The shape
 * is disambiguated by `itemType` vs. `itemSchema`:
 *
 *   - Record-list (`itemSchema` set, `itemType` absent): iOS renders an
 *     Apple-style list with NavigationLink rows; tapping a row pushes a
 *     per-record editor. Used by `quickTools`, `tabGroups`.
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
 * Visual grouping for the iOS Settings UI. Matches the desktop's own
 * Settings dialog category IDs verbatim — `general`, `ai`, `appearance`,
 * `tabs`, `git`, `quicktools`, `advanced` (no `remote` since
 * pairing/transport state is iOS-local, not projected).
 *
 * Groups render top-to-bottom in `PROJECTABLE_GROUP_ORDER` order. Adding
 * a new group is an additive change (unknown groups fall back to "Other"
 * on older iOS builds).
 */
export type ProjectableGroup =
  | 'general'
  | 'ai'
  | 'appearance'
  | 'tabs'
  | 'git'
  | 'quicktools'
  | 'advanced'

/**
 * One choice in an enum-typed projectable setting. `value` is the
 * underlying JSON value written back to disk; `label` is the
 * human-readable string the iOS picker displays.
 *
 * `value: null` is supported and represents the "None / disabled" choice
 * for nullable enums (e.g. `inProgressGroupId = null` means "no auto-
 * movement target"). The iOS picker renders the label as-is; the wire
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
export interface ProjectableSetting {
  key: string
  type: ProjectableType
  group: ProjectableGroup
  label: string
  description: string
  defaultValue: unknown
  /** For `'enum'` only — the available choices. */
  choices?: ProjectableChoice[]
  /** For `'number'` only — bounds + step. */
  range?: ProjectableRange
  /** For record-list `'list'` only — per-field metadata for one record. */
  itemSchema?: ProjectableSetting[]
  /** For primitive-list `'list'` only — type of each scalar element. */
  itemType?: ProjectablePrimitiveItemType
}

/**
 * Wire-format representation of a single allowlist entry. Sent alongside
 * the values in `desktop_settings_snapshot` so iOS can auto-render the
 * Settings detail view without hardcoding the schema.
 *
 * Distinct from `ProjectableSetting` only structurally — the schema
 * shape is what crosses the wire, while `ProjectableSetting` is the
 * source-of-truth type used by the allowlist definition. They are
 * structurally identical today; we keep them separate so future
 * desktop-only fields (e.g. an `experimental` flag) can be added to
 * `ProjectableSetting` without leaking onto the wire.
 */
export interface ProjectableSettingSchema {
  key: string
  type: ProjectableType
  group: ProjectableGroup
  label: string
  description: string
  defaultValue: unknown
  choices?: ProjectableChoice[]
  range?: ProjectableRange
  itemSchema?: ProjectableSettingSchema[]
  itemType?: ProjectablePrimitiveItemType
}
