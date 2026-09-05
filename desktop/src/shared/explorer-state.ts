/**
 * explorer-state — the shape of file-explorer tree state that outlives one
 * window and one launch.
 *
 * Expansion is keyed by ABSOLUTE root directory and holds absolute paths. That
 * keying is the behaviour, not an implementation detail: every conversation
 * showing the same directory shares one expansion list because it is looking at
 * the same files, a worktree keeps its own because its files differ from the
 * base repo's, and a folder mounted on several projects is one path and
 * therefore one entry.
 *
 * `selected` rides the same snapshot so the highlighted row follows the
 * operator between windows, but it is dropped before the state is written to
 * disk — a highlight restored from a previous launch points at nothing anyone
 * is doing.
 */

/** Everything the explorer shares between windows. */
export interface ExplorerStateSnapshot {
  version: 1
  /** Absolute root dir → absolute paths expanded under it. */
  expanded: Record<string, string[]>
  /** Absolute root dirs whose whole section is folded shut. */
  collapsedRoots: string[]
  /** Absolute root dir → highlighted row. Shared live, never persisted. */
  selected: Record<string, string>
}

/** The subset written to disk: everything except the selection highlight. */
export type PersistedExplorerState = Omit<ExplorerStateSnapshot, 'selected'>

export const EMPTY_EXPLORER_STATE: ExplorerStateSnapshot = {
  version: 1,
  expanded: {},
  collapsedRoots: [],
  selected: {},
}

/**
 * A usable path key: absolute, and free of the null byte and line breaks that
 * make a string unsafe to hand back to a filesystem caller. Matches the rule
 * `isValidProjectPath` applies at the IPC boundary.
 */
function isUsablePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !/[\0\r\n]/.test(value)
}

function absolutePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (!isUsablePath(entry) || out.includes(entry)) continue
    out.push(entry)
  }
  return out
}

/**
 * Validate a snapshot from disk or from another window into a clean value.
 *
 * Anything malformed is dropped rather than rejected wholesale: a single bad
 * key must not cost the operator every expanded folder they have.
 */
export function sanitizeExplorerState(raw: unknown): ExplorerStateSnapshot {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_EXPLORER_STATE
  const value = raw as Record<string, unknown>
  const expanded: Record<string, string[]> = {}
  if (value.expanded != null && typeof value.expanded === 'object' && !Array.isArray(value.expanded)) {
    for (const [root, paths] of Object.entries(value.expanded as Record<string, unknown>)) {
      if (!isUsablePath(root)) continue
      const list = absolutePaths(paths)
      if (list.length > 0) expanded[root] = list
    }
  }
  const selected: Record<string, string> = {}
  if (value.selected != null && typeof value.selected === 'object' && !Array.isArray(value.selected)) {
    for (const [root, path] of Object.entries(value.selected as Record<string, unknown>)) {
      if (isUsablePath(root) && isUsablePath(path)) selected[root] = path
    }
  }
  return {
    version: 1,
    expanded,
    collapsedRoots: absolutePaths(value.collapsedRoots),
    selected,
  }
}

/** Drop the live-only selection before writing to disk. */
export function toPersistedExplorerState(snapshot: ExplorerStateSnapshot): PersistedExplorerState {
  return { version: 1, expanded: snapshot.expanded, collapsedRoots: snapshot.collapsedRoots }
}

/** True when `path` is `root` itself or lives underneath it. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/**
 * Forget everything recorded for a directory and its descendants.
 *
 * Retiring a worktree deletes the checkout, so its expansion is dead weight
 * keyed to a path that no longer exists. Returns the same object when nothing
 * matched, which is what lets callers skip a pointless disk write.
 */
export function forgetExplorerStateUnder(
  snapshot: ExplorerStateSnapshot,
  directory: string,
): ExplorerStateSnapshot {
  const expandedKeys = Object.keys(snapshot.expanded).filter((root) => isUnder(root, directory))
  const collapsed = snapshot.collapsedRoots.filter((root) => !isUnder(root, directory))
  const selectedKeys = Object.keys(snapshot.selected).filter((root) => isUnder(root, directory))
  if (
    expandedKeys.length === 0 &&
    selectedKeys.length === 0 &&
    collapsed.length === snapshot.collapsedRoots.length
  ) return snapshot

  const expanded = { ...snapshot.expanded }
  for (const key of expandedKeys) delete expanded[key]
  const selected = { ...snapshot.selected }
  for (const key of selectedKeys) delete selected[key]
  return { version: 1, expanded, collapsedRoots: collapsed, selected }
}

/**
 * Drop expanded paths that are direct children of `directory` and are no longer
 * present as directories in it.
 *
 * A persisted set only ever grows otherwise: rename or delete a folder and its
 * path stays remembered forever. The check runs against the listing the tree
 * just fetched, so it needs no extra filesystem call and can only judge a
 * directory it actually read — a child of a folder nobody has opened is left
 * alone until the day it is read.
 */
export function pruneExpandedChildren(
  expandedPaths: readonly string[],
  directory: string,
  presentDirectories: readonly string[],
): string[] {
  const prefix = directory.endsWith('/') ? directory : `${directory}/`
  const present = new Set(presentDirectories)
  return expandedPaths.filter((path) => {
    if (!path.startsWith(prefix)) return true
    // Only DIRECT children are judged: a deeper path's own parent listing is
    // what decides it, and that listing may not have been read yet.
    if (path.slice(prefix.length).includes('/')) return true
    return present.has(path)
  })
}
