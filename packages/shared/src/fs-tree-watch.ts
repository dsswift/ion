/**
 * The payload of `ion:fs-tree-changed`: which directories under a watched
 * root had something created, removed, renamed, or modified inside them.
 *
 * Directories are RELATIVE to the root and forward-slashed, with `''` for the
 * root itself. A client compares them to the directories it is showing, and
 * the two sides may spell the same absolute path differently (separator,
 * drive-letter case), so an absolute path would not compare reliably.
 */
export interface FsTreeChange {
  /** The root exactly as the subscriber named it. */
  root: string
  directories: string[]
  /**
   * More directories changed than one notice carries, or the watch itself
   * reported a fault. The client re-reads everything it is showing.
   */
  overflow: boolean
  /** A `.gitignore` or `.git/info/exclude` changed, so which entries are ignored may have. */
  ignoreRulesChanged: boolean
}

/** `directory` relative to `root`, forward-slashed; `''` for the root itself; null when it is not inside the root. */
export function relativeTreeDirectory(root: string, directory: string): string | null {
  const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = normalize(root)
  const target = normalize(directory)
  // Windows compares paths without regard to case, and a drive letter reaches
  // a client in either case depending on who produced the path.
  const windows = /^[A-Za-z]:/.test(base)
  const same = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (same(target, base)) return ''
  if (target.length <= base.length || target[base.length] !== '/') return null
  if (!same(target.slice(0, base.length), base)) return null
  return target.slice(base.length + 1)
}
