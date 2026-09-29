/**
 * new-conversation-project-order — how the project list in the new-conversation
 * picker is ordered and grouped.
 *
 * Kept pure and separate from `NewConversationPicker.tsx` so the ordering
 * rules can be exercised without mounting the dialog, and because the picker
 * needs two projections of the same answer: the groups it draws, and the flat
 * list the keyboard walks.
 *
 * Usage counts are real recorded data, not an estimate. Every host bumps
 * `directoryUsageCounts[dir]` in its own settings.json when work starts in a
 * directory, and a remote host's listing carries its own count on
 * `EnvironmentProject.usageCount`. A row that is checked out on several
 * machines therefore has a count per machine, which is why "how used is this
 * project" and "how used is it on that machine" are different questions here:
 * an ungrouped list ranks a project by its total across every machine that has
 * it, while a per-host group ranks it by that host's own count.
 */
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { MergedProjectRow } from '../studio/connection/environment-projects'
import { LOCAL_ENVIRONMENT_LABEL } from '../studio/connection/local-label'

/** Most used is the default: the picker exists to reach the project you reach most. */
export type ProjectSortOrder = 'most-used' | 'alphabetical'
export type ProjectGrouping = 'local-first' | 'by-host' | 'none'

export const PROJECT_SORT_ORDERS: readonly ProjectSortOrder[] = ['most-used', 'alphabetical']
export const PROJECT_GROUPINGS: readonly ProjectGrouping[] = ['local-first', 'by-host', 'none']

/** One drawn section. `label` is null for the single unlabelled section. */
export interface ProjectGroup {
  key: string
  label: string | null
  /**
   * The machine every row in this section opens on, when the section IS a
   * machine (`by-host`). Null when the section mixes machines, and each row
   * then falls back to its own default.
   */
  environmentId: string | null
  rows: MergedProjectRow[]
}

/** A row as the keyboard walks it: which section it came from decides where it opens. */
export interface FlatProjectRow {
  row: MergedProjectRow
  /** Non-null only inside a per-host section. */
  environmentId: string | null
  groupKey: string
}

export function isProjectSortOrder(value: unknown): value is ProjectSortOrder {
  return typeof value === 'string' && (PROJECT_SORT_ORDERS as readonly string[]).includes(value)
}

export function isProjectGrouping(value: unknown): value is ProjectGrouping {
  return typeof value === 'string' && (PROJECT_GROUPINGS as readonly string[]).includes(value)
}

/** This project's recorded use on one machine. */
export function usageOn(row: MergedProjectRow, environmentId: string): number {
  return row.holders.find((holder) => holder.environmentId === environmentId)?.usageCount ?? 0
}

/** This project's recorded use across every machine that has it. */
export function totalUsage(row: MergedProjectRow): number {
  return row.holders.reduce((sum, holder) => sum + holder.usageCount, 0)
}

/** Name then path, so equal-usage rows never reorder between renders. */
function byName(left: MergedProjectRow, right: MergedProjectRow): number {
  return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' })
    || left.dir.localeCompare(right.dir)
}

/**
 * Orders rows by `order`. `usageFor` is the count the ranking uses, which is
 * the per-host count inside a per-host section and the cross-machine total
 * everywhere else. An untouched project has no count, so a list of them falls
 * through to the alphabetical tiebreak rather than landing in arbitrary order.
 */
export function sortProjectRows(
  rows: readonly MergedProjectRow[],
  order: ProjectSortOrder,
  usageFor: (row: MergedProjectRow) => number = totalUsage,
): MergedProjectRow[] {
  const out = [...rows]
  if (order === 'alphabetical') return out.sort(byName)
  return out.sort((left, right) => usageFor(right) - usageFor(left) || byName(left, right))
}

/**
 * Splits rows into the sections to draw.
 *
 * - `local-first`: this machine's projects, then the ones it does not have.
 *   Two sections only when both are occupied, so a single-machine setup and a
 *   filtered search never render a header over an empty half.
 * - `by-host`: one section per machine in catalog order, holding the projects
 *   that machine actually has. A project on three machines appears in three
 *   sections, and in each one it opens on that machine — which is the whole
 *   point of the mode, and why it is not deduplicated.
 * - `none`: one unlabelled section.
 */
export function groupProjectRows(args: {
  rows: readonly MergedProjectRow[]
  grouping: ProjectGrouping
  order: ProjectSortOrder
  catalog: ReadonlyArray<{ id: string; label: string }>
}): ProjectGroup[] {
  const { rows, grouping, order, catalog } = args
  if (grouping === 'by-host') {
    const groups: ProjectGroup[] = []
    for (const environment of catalog) {
      const held = rows.filter((row) => row.holders.some((holder) => holder.environmentId === environment.id))
      if (held.length === 0) continue
      groups.push({
        key: `host:${environment.id}`,
        label: environment.label,
        environmentId: environment.id,
        rows: sortProjectRows(held, order, (row) => usageOn(row, environment.id)),
      })
    }
    return groups
  }

  const sorted = sortProjectRows(rows, order)
  if (grouping === 'none') {
    return sorted.length === 0 ? [] : [{ key: 'all', label: null, environmentId: null, rows: sorted }]
  }

  const local = sorted.filter((row) => row.holders.some((holder) => holder.environmentId === LOCAL_ENVIRONMENT_ID))
  const remote = sorted.filter((row) => !row.holders.some((holder) => holder.environmentId === LOCAL_ENVIRONMENT_ID))
  // One occupied half is just a list; a header over it would label the only
  // thing on screen.
  if (local.length === 0 || remote.length === 0) {
    const only = local.length === 0 ? remote : local
    return only.length === 0 ? [] : [{ key: 'all', label: null, environmentId: null, rows: only }]
  }
  const localLabel = catalog.find((entry) => entry.id === LOCAL_ENVIRONMENT_ID)?.label ?? LOCAL_ENVIRONMENT_LABEL
  return [
    { key: 'local', label: localLabel, environmentId: null, rows: local },
    { key: 'remote', label: 'Other machines', environmentId: null, rows: remote },
  ]
}

/** The rows the keyboard walks, in drawn order, skipping collapsed sections. */
export function flattenProjectGroups(
  groups: readonly ProjectGroup[],
  collapsed: ReadonlySet<string> = new Set(),
): FlatProjectRow[] {
  const out: FlatProjectRow[] = []
  for (const group of groups) {
    if (group.label !== null && collapsed.has(group.key)) continue
    for (const row of group.rows) out.push({ row, environmentId: group.environmentId, groupKey: group.key })
  }
  return out
}
