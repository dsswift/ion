/**
 * Item-schemas for list-of-records projectable settings.
 *
 * The `PROJECTABLE_SETTINGS` allowlist supports a `'list'` type whose value
 * is an array of objects. Each list entry declares an `itemSchema` —
 * itself an array of `ProjectableSetting`-shaped descriptors — so iOS can
 * render a per-record editor without hardcoding the record shape.
 *
 * The two list-typed settings today are `quickTools` (custom shell-command
 * buttons users can fire from a tab) and `tabGroups` (user-defined tab
 * groups). Both are managed entirely from the desktop today; the
 * itemSchemas below give iOS the metadata it needs to add, edit, delete,
 * and reorder them from a phone.
 *
 * These itemSchemas are imported back into `projectable-settings.ts`
 * rather than declared inline because the parent file would otherwise
 * blow past the 800-line Go / 600-line TS cap. The split is purely
 * mechanical — every entry below is structurally a `ProjectableSetting`
 * and would type-check identically if pasted into the main array.
 */

import type { ProjectableSetting } from './projectable-settings-types'

/**
 * Per-field metadata for one QuickTool record. Mirrors the runtime shape
 * in `desktop/src/shared/types-session.ts` (`QuickTool` interface).
 *
 * The `id` field is required on the wire but not exposed as an editable
 * row — iOS auto-assigns a UUID on "Add" and preserves it through edits.
 * We still list it here (type `'string'`, hidden flag absent on the
 * schema today) so the validator can sanity-check shape on writes; the
 * iOS list editor will simply skip rendering keys whose `label` starts
 * with `_` (internal convention) once we add that flag, or hardcode the
 * `id` skip until then.
 */
export const QUICK_TOOL_ITEM_SCHEMA: ProjectableSetting[] = [
  {
    key: 'id',
    type: 'string',
    group: 'quicktools',
    label: 'ID',
    description: 'Internal identifier (auto-assigned).',
    defaultValue: '',
  },
  {
    key: 'name',
    type: 'string',
    group: 'quicktools',
    label: 'Name',
    description: 'Display label, e.g. "Merge Flow".',
    defaultValue: '',
  },
  {
    key: 'icon',
    type: 'string',
    group: 'quicktools',
    label: 'Icon',
    description: 'Phosphor icon name, e.g. "GitMerge". Falls back to "Lightning" if unknown.',
    defaultValue: 'Lightning',
  },
  {
    key: 'command',
    type: 'string',
    group: 'quicktools',
    label: 'Command',
    description: 'Shell command to run. Supports {cwd} and {branch} placeholders.',
    defaultValue: '',
  },
]

/**
 * Per-field metadata for one TabGroup record. Mirrors the runtime shape
 * in `desktop/src/shared/types.ts` (`TabGroup` interface — id, label,
 * isDefault, order, collapsed).
 *
 * Field render policy (enforced in the iOS list editor):
 *   - `id` — auto-assigned UUID, never rendered.
 *   - `order` — auto-managed from the iOS list index on every send,
 *     never rendered.
 *   - `collapsed` — runtime UI state owned by the desktop, never
 *     rendered.
 *
 * We still ship these on the schema so the iOS editor synthesizes them
 * on new records (with their schema defaults) and round-trips them on
 * edits — without the schema entries, the desktop would receive
 * partially-populated records missing required fields.
 */
export const TAB_GROUP_ITEM_SCHEMA: ProjectableSetting[] = [
  {
    key: 'id',
    type: 'string',
    group: 'tabs',
    label: 'ID',
    description: 'Internal identifier (auto-assigned).',
    defaultValue: '',
  },
  {
    key: 'label',
    type: 'string',
    group: 'tabs',
    label: 'Label',
    description: 'Display name for the group.',
    defaultValue: '',
  },
  {
    key: 'isDefault',
    type: 'boolean',
    group: 'tabs',
    label: 'Default Group',
    description: 'New tabs are assigned to this group when no other group rule matches.',
    defaultValue: false,
  },
  {
    key: 'order',
    type: 'number',
    group: 'tabs',
    label: 'Order',
    description: 'Position in the strip (auto-managed by drag-to-reorder).',
    defaultValue: 0,
  },
  {
    key: 'collapsed',
    type: 'boolean',
    group: 'tabs',
    label: 'Collapsed',
    description: 'Whether the group renders as a single collapsed pill on the desktop.',
    defaultValue: true,
  },
]
