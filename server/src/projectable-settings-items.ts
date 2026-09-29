/**
 * Item-schemas for list-of-records projectable settings.
 *
 * The `PROJECTABLE_SETTINGS` allowlist supports a `'list'` type whose value
 * is an array of objects. Each list entry declares an `itemSchema` —
 * itself an array of `ProjectableItemField` descriptors — so iOS can
 * render a per-record editor without hardcoding the record shape.
 *
 * The list-typed setting today is `quickTools` (custom shell-command
 * buttons users can fire from a conversation). It is managed from the
 * desktop; the itemSchema below gives iOS the metadata it needs to add,
 * edit, delete, and reorder entries from a phone.
 *
 * These itemSchemas are imported back into `projectable-settings.ts`
 * rather than declared inline because the parent file would otherwise
 * blow past the 800-line Go / 600-line TS cap. The split is purely
 * mechanical — every entry below is structurally a `ProjectableItemField`
 * and would type-check identically if pasted into the main array.
 */

import type { ProjectableItemField } from './projectable-settings-types'

/**
 * Per-field metadata for one QuickTool record. Mirrors the runtime shape
 * in `packages/shared/src/types-session.ts` (`QuickTool` interface).
 *
 * The `id` field is required on the wire but not exposed as an editable
 * row — iOS auto-assigns a UUID on "Add" and preserves it through edits.
 * We still list it here (type `'string'`, hidden flag absent on the
 * schema today) so the validator can sanity-check shape on writes; the
 * iOS list editor will simply skip rendering keys whose `label` starts
 * with `_` (internal convention) once we add that flag, or hardcode the
 * `id` skip until then.
 */
export const QUICK_TOOL_ITEM_SCHEMA: ProjectableItemField[] = [
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
    description:
      'Phosphor icon name, e.g. "GitMerge". Falls back to "Lightning" if unknown.',
    defaultValue: 'Lightning',
  },
  {
    key: 'command',
    type: 'string',
    group: 'quicktools',
    label: 'Command',
    description:
      'Shell command to run. Supports {cwd} and {branch} placeholders.',
    defaultValue: '',
  },
]

