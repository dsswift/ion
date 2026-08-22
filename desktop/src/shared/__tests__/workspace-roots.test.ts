/**
 * workspace-roots — per-project map resolution, dedupe, ordering.
 */
import { describe, it, expect } from 'vitest'
import { normalizeWorkspacePath, orderedWorkspaceRoots, sanitizeWorkspaceFolders } from '../workspace-roots'

describe('normalizeWorkspacePath', () => {
  it('trims and strips trailing slashes, keeping root', () => {
    expect(normalizeWorkspacePath(' /a/b/ ')).toBe('/a/b')
    expect(normalizeWorkspacePath('/a/b///')).toBe('/a/b')
    expect(normalizeWorkspacePath('/')).toBe('/')
  })
})

describe('orderedWorkspaceRoots', () => {
  const map = {
    '/proj/a': ['/lib/z', '/lib/a', '/proj/a', '/lib/a/'],
    '/proj/b': ['/other/root'],
  }

  it('resolves the active project entry: dedupe, primary excluded, sorted', () => {
    const out = orderedWorkspaceRoots('/proj/a', map)
    expect(out.primary).toBe('/proj/a')
    expect(out.secondary).toEqual(['/lib/a', '/lib/z'])
  })

  it('per-project isolation: project A roots never leak into project B', () => {
    const out = orderedWorkspaceRoots('/proj/b', map)
    expect(out.secondary).toEqual(['/other/root'])
  })

  it('unknown project → primary only', () => {
    expect(orderedWorkspaceRoots('/proj/unknown', map)).toEqual({ primary: '/proj/unknown', secondary: [] })
  })

  it("no-directory tab ('~' or empty) → primary null, no roots", () => {
    expect(orderedWorkspaceRoots('~', map)).toEqual({ primary: null, secondary: [] })
    expect(orderedWorkspaceRoots('', map)).toEqual({ primary: null, secondary: [] })
    expect(orderedWorkspaceRoots(null, map)).toEqual({ primary: null, secondary: [] })
  })

  it('trailing-slash active dir normalizes to the same project key', () => {
    expect(orderedWorkspaceRoots('/proj/a/', map).secondary).toEqual(['/lib/a', '/lib/z'])
  })

  it('relative and junk entries are dropped', () => {
    const out = orderedWorkspaceRoots('/p', { '/p': ['relative/path', '', '/ok'] })
    expect(out.secondary).toEqual(['/ok'])
  })
})

describe('sanitizeWorkspaceFolders', () => {
  it('malformed disk → {}', () => {
    expect(sanitizeWorkspaceFolders(null)).toEqual({})
    expect(sanitizeWorkspaceFolders('junk')).toEqual({})
    expect(sanitizeWorkspaceFolders([])).toEqual({})
    expect(sanitizeWorkspaceFolders(42)).toEqual({})
  })

  it('filters non-arrays, relative keys/values, self-references, dupes', () => {
    expect(
      sanitizeWorkspaceFolders({
        '/p': ['/a', '/a', '/p', 'rel', 7],
        'rel-key': ['/x'],
        '/empty': ['not-absolute'],
        '/scalar': 'nope',
      }),
    ).toEqual({ '/p': ['/a'] })
  })
})
