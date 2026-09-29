/**
 * Platform-agnostic path predicates and helpers shared by the renderer and
 * main process. Manifest contract C8 (windows-mvp program). Every check
 * handles both POSIX ('/') and Windows ('\', a drive letter, or a UNC
 * share) separator conventions, because the desktop's workspace roots,
 * recent directories, and terminal expansions can all carry a Windows path
 * once the desktop runs there.
 */

const DRIVE_RE = /^[A-Za-z]:[\\/]/

/**
 * Reports whether p is an absolute path on any supported platform: a
 * leading '/', a Windows drive letter ('C:\' or 'C:/'), or a UNC share
 * ('\\server\share').
 */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\\\') || DRIVE_RE.test(p)
}

/**
 * Rewrites every backslash to a forward slash so two spellings of one path
 * compare equal.
 *
 * A Windows path reaches the renderer from both git (forward slashes) and
 * Node's join (backslashes) inside a single view, so any comparison across
 * that boundary has to normalize first. Comparing raw strings is why no
 * Windows path was ever recognised as git-ignored, and nothing in the file
 * tree was dimmed.
 */
export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Splits p on both '/' and '\', dropping empty segments. */
export function pathSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean)
}

/**
 * The last segment of a path in either separator style, or p itself when it
 * has none. `p.split('/').pop()` answered with the whole path for a Windows
 * path, so every label built that way read `C:\Users\...\repo` where a
 * Mac read `repo`.
 */
export function pathBasename(p: string): string {
  return pathSegments(p).pop() ?? p
}

/**
 * Everything before the last separator of either style, or '' when p has
 * none. A root-level path keeps its root ('/' or 'C:\\').
 */
export function pathDirname(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (cut === -1) return ''
  if (cut === 0) return '/'
  const head = p.slice(0, cut)
  return /^[A-Za-z]:$/.test(head) ? `${head}\\` : head
}

/**
 * Joins base and rel using whichever separator base already uses ('\\' when
 * base contains a backslash and no forward slash; '/' otherwise). This
 * keeps a joined path visually consistent with the string the caller
 * started from, rather than always normalizing to one platform's style.
 */
export function joinPath(base: string, rel: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.endsWith(sep) ? base + rel : base + sep + rel
}
