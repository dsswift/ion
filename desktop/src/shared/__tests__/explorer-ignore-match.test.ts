import { describe, it, expect } from 'vitest'
import { normalizeSlashes } from '../paths'

/**
 * The explorer compares two path spellings that disagree on Windows: git
 * reports `node_modules/` with forward slashes, and the main process joins
 * that onto the root with Node's join, which uses backslashes. Comparing the
 * raw strings meant no Windows path was ever recognised as ignored, so nothing
 * in the tree was ever dimmed.
 *
 * This models the matcher so the rule is pinned without mounting the tree.
 */
function isIgnored(filePath: string, ignoredPaths: Set<string>): boolean {
  const target = normalizeSlashes(filePath)
  for (const raw of ignoredPaths) {
    const p = normalizeSlashes(raw)
    const base = p.endsWith('/') ? p.slice(0, -1) : p
    if (target === base) return true
    if (target.startsWith(base + '/')) return true
  }
  return false
}

describe('ignore matching is separator-agnostic', () => {
  // Exactly the mismatch on the endpoint: backslash target, backslash-joined
  // ignore entry with git's trailing slash preserved.
  const winIgnored = new Set(['C:\\repo\\node_modules/'])

  it.each([
    'C:\\repo\\node_modules',
    'C:\\repo\\node_modules\\pkg',
    'C:\\repo\\node_modules\\pkg\\index.js',
    'C:/repo/node_modules/pkg',
  ])('matches %s', (p) => {
    expect(isIgnored(p, winIgnored)).toBe(true)
  })

  it('does not match a sibling that merely shares a prefix', () => {
    // node_modules2 is not inside node_modules; a bare startsWith without the
    // separator boundary would wrongly dim it.
    expect(isIgnored('C:\\repo\\node_modules2\\a.js', winIgnored)).toBe(false)
  })

  it('does not match an unrelated path', () => {
    expect(isIgnored('C:\\repo\\src\\main.ts', winIgnored)).toBe(false)
  })

  // POSIX must keep working; this is one matcher for both platforms.
  const posixIgnored = new Set(['/repo/dist/'])

  it.each(['/repo/dist', '/repo/dist/bundle.js'])('still matches %s', (p) => {
    expect(isIgnored(p, posixIgnored)).toBe(true)
  })

  it('still rejects /repo/dist2 on posix', () => {
    expect(isIgnored('/repo/dist2/x', posixIgnored)).toBe(false)
  })

  // An ignore entry with no trailing slash (a file, not a directory).
  it('matches a file entry exactly', () => {
    expect(isIgnored('C:\\repo\\.env', new Set(['C:\\repo\\.env']))).toBe(true)
  })
})
