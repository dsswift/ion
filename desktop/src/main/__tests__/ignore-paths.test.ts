/**
 * Tests for git watcher ignore-path matching (ignore-paths.ts).
 */

import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { expandHome, isPathIgnoredByGitWatcher } from '../git/ignore-paths'

const HOME = homedir()
const HOME_ION = HOME + '/.ion'

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

/**
 * The exemption is what keeps a worktree's Diff panel live.
 *
 * `gitWatcherIgnoredDirectories` defaults to `~/.ion`, and Ion stores real
 * source checkouts under it (`~/.ion/worktrees/...`, `~/.ion/integration/...`).
 * Before the exemption every one of those matched the ignore rule and ran with
 * the watcher suppressed, so the Diff panel and the git Changes list received
 * no file events at all and only refreshed on window focus.
 */
describe('isPathIgnoredByGitWatcher — managed-checkout exemption', () => {
  const WORKTREE = HOME_ION + '/worktrees/ion-6d15c16e'
  const BENCH = HOME_ION + '/integration/ion-josh'

  it('watches a registered worktree that sits inside an ignored directory', () => {
    expect(isPathIgnoredByGitWatcher(WORKTREE, [HOME_ION])).toBe(true)
    expect(isPathIgnoredByGitWatcher(WORKTREE, [HOME_ION], [WORKTREE])).toBe(false)
  })

  it('watches an integration bench on the same rule', () => {
    expect(isPathIgnoredByGitWatcher(BENCH, [HOME_ION], [WORKTREE, BENCH])).toBe(false)
  })

  it('still ignores everything else under the ignored directory', () => {
    for (const other of [HOME_ION, HOME_ION + '/conversations', HOME_ION + '/worktrees']) {
      expect(isPathIgnoredByGitWatcher(other, [HOME_ION], [WORKTREE, BENCH])).toBe(true)
    }
  })

  // The exemption names a checkout root, not a subtree. A nested path is not
  // separately retained as a repository, and implying a subtree would let an
  // exemption silently widen past what the records actually describe.
  it('does not exempt a subdirectory of an exempt checkout', () => {
    expect(isPathIgnoredByGitWatcher(WORKTREE + '/desktop', [HOME_ION], [WORKTREE])).toBe(true)
  })

  it('leaves unignored paths unignored whether or not they are exempt', () => {
    expect(isPathIgnoredByGitWatcher('/tmp/repo', [HOME_ION], [])).toBe(false)
    expect(isPathIgnoredByGitWatcher('/tmp/repo', [HOME_ION], ['/tmp/repo'])).toBe(false)
  })

  // A more specific ignore entry is the more specific instruction. An operator
  // who explicitly ignores one worktree must not be overridden by the blanket
  // exemption that covers every registered checkout.
  it('honours an ignore entry more specific than the exemption', () => {
    expect(isPathIgnoredByGitWatcher(WORKTREE, [HOME_ION, WORKTREE], [WORKTREE])).toBe(true)
  })

  it('is a no-op when nothing is exempt', () => {
    expect(isPathIgnoredByGitWatcher(WORKTREE, [HOME_ION], [])).toBe(true)
  })
})
