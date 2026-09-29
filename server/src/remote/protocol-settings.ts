/**
 * Wire shape for one entry in `desktop_settings_snapshot.schema`.
 *
 * Mirrors `ProjectableSettingSchema` from
 * `server/src/projectable-settings-types.ts`. Declared as a named
 * interface so recursive `itemSchema` can name itself. The recursion supports
 * list settings whose records contain scalar sub-fields and leaves room for
 * future nested lists without a wire-protocol change.
 */
export interface DesktopSettingsSchemaEntry {
  key: string
  type: 'boolean' | 'string' | 'number' | 'enum' | 'list'
  group: string
  /** The settings page showing this key (`@ion/shared/settings-taxonomy`). Absent on a nested `itemSchema` field. */
  page?: string
  /** The section of `page` showing this key. Absent on a nested `itemSchema` field. */
  section?: string
  label: string
  description: string
  defaultValue: unknown
  choices?: Array<{ value: string | null; label: string }>
  range?: { min: number; max: number; step: number }
  itemSchema?: DesktopSettingsSchemaEntry[]
  /** The key's scope in the settings registry. An `environment` entry is read-only on a client whose snapshot says `canManageEnvironment: false`. */
  scope?: import('@ion/shared/settings-registry').SettingScope
  itemType?: 'boolean' | 'string' | 'number' | 'enum'
}
