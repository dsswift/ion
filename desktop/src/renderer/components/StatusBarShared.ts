/* ─── Shared helpers for StatusBar sibling components ─── */

/** Get a compact display path: basename for deep paths, ~ for home */
export function compactPath(fullPath: string): string {
  if (fullPath === '~') return '~'
  const parts = fullPath.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || fullPath
}
