/**
 * Minimal, pure POSIX path helpers.
 *
 * `graph-model-edges.ts` runs in the renderer (this module lives in
 * `shared/` but is renderer-executed per the program design), so it cannot
 * import Node's `path` module — Vite externalizes it for the browser
 * target and the build fails. Corpus paths are always absolute POSIX paths
 * (the main-process scanner joins with `/` on every supported platform),
 * so a small POSIX-only implementation is exact, not an approximation.
 */

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/')
}

export function dirnamePath(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return p.slice(0, idx)
}

export function joinPaths(...segments: string[]): string {
  const joined = segments.filter((s) => s.length > 0).join('/')
  return normalizePath(joined)
}

/** Collapse `.`, `..`, and repeated slashes. Preserves a leading `/`. */
export function normalizePath(p: string): string {
  const absolute = isAbsolutePath(p)
  const parts = p.split('/').filter((part) => part.length > 0 && part !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
    } else {
      out.push(part)
    }
  }
  const result = out.join('/')
  return absolute ? `/${result}` : result || '.'
}
