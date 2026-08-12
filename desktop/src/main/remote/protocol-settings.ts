/**
 * Wire shape for one entry in `desktop_settings_snapshot.schema`.
 *
 * Mirrors `ProjectableSettingSchema` from
 * `desktop/src/main/projectable-settings-types.ts`. Declared as a named
 * interface so recursive `itemSchema` can name itself. The recursion supports
 * list settings whose records contain scalar sub-fields and leaves room for
 * future nested lists without a wire-protocol change.
 */
export interface DesktopSettingsSchemaEntry {
  key: string
  type: 'boolean' | 'string' | 'number' | 'enum' | 'list'
  group: string
  label: string
  description: string
  defaultValue: unknown
  choices?: Array<{ value: string | null; label: string }>
  range?: { min: number; max: number; step: number }
  itemSchema?: DesktopSettingsSchemaEntry[]
  itemType?: 'boolean' | 'string' | 'number' | 'enum'
}
