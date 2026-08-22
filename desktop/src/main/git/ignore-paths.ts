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
 *
 * `exempt` holds paths that are watched even when they fall inside an ignored
 * entry, and it exists because the default ignore (`~/.ion`) means "do not
 * watch Ion's own data" while Ion ALSO stores real source checkouts there:
 * worktrees at `~/.ion/worktrees/...` and integration benches at
 * `~/.ion/integration/...`. Without the exemption every one of those checkouts
 * was silently unwatched -- the Diff panel and the git Changes list saw no
 * file events at all and only refreshed when the window regained focus, so a
 * conversation sitting in its own worktree showed a frozen diff.
 *
 * Narrowing the ignore default to `~/.ion`'s noisy children instead would fix
 * the symptom once and rot: the next noisy directory added under `~/.ion`
 * reintroduces the churn the ignore exists to prevent. Exempting the checkouts
 * encodes the real distinction (a checkout is never Ion's data, wherever it
 * sits) and stays correct as `~/.ion` grows.
 *
 * An exemption applies only when the checkout is caught by a PARENT ignore
 * entry. An entry naming the checkout exactly is a deliberate instruction about
 * that specific directory, and it outranks the blanket exemption — an operator
 * who ignores one noisy worktree by name keeps it ignored.
 */
export function isPathIgnoredByGitWatcher(
  dir: string,
  ignored: string[],
  exempt: readonly string[] = [],
): boolean {
  let matchedExactly = false
  let matchedParent = false
  for (const entry of ignored) {
    if (dir === entry) matchedExactly = true
    else if (dir.startsWith(entry + '/')) matchedParent = true
  }
  if (matchedExactly) return true
  if (!matchedParent) return false
  return !exempt.includes(dir)
}
