/**
 * Path-matching utilities for the git watcher ignore list.
 *
 * All functions are pure -- no filesystem I/O, no side effects.
 */

import { homedir } from 'os'

/**
 * Expand `~` and `$HOME` prefixes to the real home directory.
 * Any path that does not start with `~` or `$HOME` is returned unchanged.
 */
export function expandHome(p: string): string {
  const home = homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return home + p.slice(1)
  if (p === '$HOME') return home
  if (p.startsWith('$HOME/')) return home + p.slice(5)
  return p
}

/**
 * Returns true when `dir` equals an ignored entry or is nested under one.
 *
 * Matching is segment-aware: `/a/b` matches entries `/a/b` (exact) and `/a`
 * (parent), but NOT `/a/bc` (same prefix, different segment boundary).
 *
 * The `ignored` list must already be expanded to absolute paths -- call
 * `expandHome` on each entry before passing here.
 */
export function isPathIgnoredByGitWatcher(dir: string, ignored: string[]): boolean {
  for (const entry of ignored) {
    if (dir === entry) return true
    if (dir.startsWith(entry + '/')) return true
  }
  return false
}
