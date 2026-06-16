/**
 * Tests for git watcher ignore-path matching (ignore-paths.ts).
 */

import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { expandHome, isPathIgnoredByGitWatcher } from '../git/ignore-paths'

const HOME = homedir()

describe('expandHome', () => {
  it('expands bare ~ to homedir', () => {
    expect(expandHome('~')).toBe(HOME)
  })

  it('expands ~/subdir to homedir + /subdir', () => {
    expect(expandHome('~/.ion')).toBe(HOME + '/.ion')
    expect(expandHome('~/foo/bar')).toBe(HOME + '/foo/bar')
  })

  it('expands $HOME to homedir', () => {
    expect(expandHome('$HOME')).toBe(HOME)
  })

  it('expands $HOME/subdir to homedir + /subdir', () => {
    expect(expandHome('$HOME/.ion')).toBe(HOME + '/.ion')
    expect(expandHome('$HOME/foo/bar')).toBe(HOME + '/foo/bar')
  })

  it('returns absolute paths unchanged', () => {
    expect(expandHome('/Users/me/code')).toBe('/Users/me/code')
  })

  it('returns paths that are not ~ or $HOME prefixed unchanged', () => {
    expect(expandHome('relative/path')).toBe('relative/path')
    expect(expandHome('$OTHER/path')).toBe('$OTHER/path')
  })
})

describe('isPathIgnoredByGitWatcher', () => {
  const HOME_ION = HOME + '/.ion'

  it('returns false for empty ignored list', () => {
    expect(isPathIgnoredByGitWatcher(HOME_ION, [])).toBe(false)
  })

  it('returns true when dir exactly matches an ignored entry', () => {
    expect(isPathIgnoredByGitWatcher(HOME_ION, [HOME_ION])).toBe(true)
  })

  it('returns true when dir is a subdirectory of an ignored entry', () => {
    expect(isPathIgnoredByGitWatcher(HOME_ION + '/conversations', [HOME_ION])).toBe(true)
    expect(isPathIgnoredByGitWatcher(HOME_ION + '/a/b/c', [HOME_ION])).toBe(true)
  })

  it('returns false for a sibling with shared prefix (segment-aware)', () => {
    // /Users/me/.ion must NOT match /Users/me/.ionx
    expect(isPathIgnoredByGitWatcher(HOME + '/.ionx', [HOME_ION])).toBe(false)
    expect(isPathIgnoredByGitWatcher(HOME + '/.ionother', [HOME_ION])).toBe(false)
  })

  it('returns false for unrelated path', () => {
    expect(isPathIgnoredByGitWatcher('/tmp/myrepo', [HOME_ION])).toBe(false)
  })

  it('works after tilde expansion (integration)', () => {
    // Simulate what readGitWatcherIgnoredDirectories returns: expanded paths.
    const expanded = [expandHome('~/.ion')]
    expect(isPathIgnoredByGitWatcher(HOME_ION, expanded)).toBe(true)
    expect(isPathIgnoredByGitWatcher(HOME_ION + '/conversations', expanded)).toBe(true)
    expect(isPathIgnoredByGitWatcher(HOME + '/.ionx', expanded)).toBe(false)
  })

  it('handles multiple ignored entries', () => {
    const ignored = [HOME + '/.ion', '/tmp/skip']
    expect(isPathIgnoredByGitWatcher('/tmp/skip', ignored)).toBe(true)
    expect(isPathIgnoredByGitWatcher('/tmp/skip/sub', ignored)).toBe(true)
    expect(isPathIgnoredByGitWatcher('/tmp/other', ignored)).toBe(false)
  })

  it('both ~ and $HOME expansion produce the same ignored set', () => {
    const fromTilde = [expandHome('~/.ion')]
    const fromHome = [expandHome('$HOME/.ion')]
    expect(fromTilde).toEqual(fromHome)
    expect(isPathIgnoredByGitWatcher(HOME_ION, fromTilde)).toBe(true)
    expect(isPathIgnoredByGitWatcher(HOME_ION, fromHome)).toBe(true)
  })
})
