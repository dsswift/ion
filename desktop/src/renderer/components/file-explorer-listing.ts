/**
 * Comparisons the Explorer tree makes on every refresh, kept pure so a
 * refresh that found nothing new can be recognised and write nothing.
 */
import type { FsEntry } from '@ion/shared/types'
import { normalizeSlashes } from '@ion/shared/paths'

/** Whether two listings of one directory would render the same rows. Size and modified time are not rendered. */
export function sameListing(before: readonly FsEntry[] | undefined, after: readonly FsEntry[]): boolean {
  if (!before || before.length !== after.length) return false
  return before.every((entry, i) => {
    const other = after[i]
    return entry.path === other.path && entry.name === other.name && entry.isDirectory === other.isDirectory && entry.isHidden === other.isHidden
  })
}

export function sameIgnoredPaths(before: ReadonlySet<string>, after: readonly string[]): boolean {
  return before.size === after.length && after.every((path) => before.has(path))
}

/**
 * A predicate answering whether a path is git-ignored: the path itself is
 * listed, or one of its ancestors is.
 *
 * Separator-agnostic, because the two sides disagree on Windows: git reports
 * `node_modules/` with forward slashes, and the listing joins names onto the
 * root with backslashes. Comparing the raw strings meant no Windows path ever
 * matched, so nothing in the tree was dimmed as ignored.
 *
 * git marks a directory with a trailing slash. It is stripped so the
 * directory ITSELF matches, and ancestors are matched whole, so a
 * same-prefix sibling does not.
 */
export function ignoredPathMatcher(ignoredPaths: Iterable<string>): (filePath: string) => boolean {
  const ignored = new Set<string>()
  for (const raw of ignoredPaths) {
    const path = normalizeSlashes(raw)
    ignored.add(path.endsWith('/') ? path.slice(0, -1) : path)
  }
  return (filePath) => {
    if (ignored.size === 0) return false
    let candidate = normalizeSlashes(filePath)
    for (;;) {
      if (ignored.has(candidate)) return true
      const cut = candidate.lastIndexOf('/')
      if (cut <= 0) return false
      candidate = candidate.slice(0, cut)
    }
  }
}
