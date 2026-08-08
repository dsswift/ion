/**
 * Recent-directory policy.
 *
 * Ion-managed worktrees and integration benches are ephemeral workspace
 * directories. They have named navigation surfaces, so recording their raw
 * paths as generic project recents is redundant and leaves invalid paths after
 * retirement or bench rebuilds.
 *
 * This module stays browser-safe: renderer code cannot import Node's `path` or
 * `os` modules. Both slash kinds are accepted because persisted and remote data
 * can originate on another platform.
 */
const SEPARATOR = /[\\/]+/
const TILDE_ION_ROOT = ['~', '.ion']
const ABSOLUTE_ION_ROOT = ['.ion']
const EPHEMERAL_ROOTS = new Set(['worktrees', 'integration'])

function pathSegments(path: string): string[] {
  return path.trim().split(SEPARATOR).filter(Boolean)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * True when a path names or lives inside Ion's managed worktree or bench roots.
 *
 * `~/.ion/...` and an absolute path containing `/.ion/...` identify the same
 * managed roots. Relative `foo/.ion/worktrees` is intentionally not treated as
 * managed: only Ion's user-state root owns this policy. A sibling such as
 * `~/.ion/worktrees-old` remains a valid ordinary project directory.
 */
export function isEphemeralWorkspaceDirectory(path: string): boolean {
  const trimmed = path.trim()
  const segments = pathSegments(trimmed)
  if (segments.length < 2) return false

  const startsAtTildeRoot = segments[0] === TILDE_ION_ROOT[0]
    && segments[1] === TILDE_ION_ROOT[1]
    && EPHEMERAL_ROOTS.has(segments[2] ?? '')
  if (startsAtTildeRoot) return true

  if (!isAbsolutePath(trimmed)) return false
  for (let index = 0; index <= segments.length - 2; index++) {
    if (segments[index] !== ABSOLUTE_ION_ROOT[0]) continue
    if (EPHEMERAL_ROOTS.has(segments[index + 1])) return true
  }
  return false
}

export interface SanitizedRecentDirectories {
  directories: string[]
  usageCounts: Record<string, number>
  removed: boolean
}

/**
 * Keep recents in their current order while removing ephemeral entries and
 * matching usage counters. Other stale paths stay intact: network volumes and
 * remote-machine paths can be valid even when this process cannot stat them.
 */
export function sanitizeRecentDirectories(
  directories: readonly string[],
  usageCounts: Readonly<Record<string, number>> = {},
): SanitizedRecentDirectories {
  const retained = directories.filter((directory) => !isEphemeralWorkspaceDirectory(directory))
  const nextUsageCounts = Object.fromEntries(
    Object.entries(usageCounts).filter(([directory]) => !isEphemeralWorkspaceDirectory(directory)),
  )
  const removed = retained.length !== directories.length
    || Object.keys(nextUsageCounts).length !== Object.keys(usageCounts).length
  return { directories: retained, usageCounts: nextUsageCounts, removed }
}

/** Sanitize only directory projection when usage metadata is not present. */
export function recentLocalDirectories(directories: readonly string[]): string[] {
  return sanitizeRecentDirectories(directories).directories
}
