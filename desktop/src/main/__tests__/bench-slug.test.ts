/**
 * benchSlug — the filesystem-safe (repo, branch) slug used to build the bench
 * worktree path under `.ion/integration/`.
 *
 * Regression test for a real Windows CI failure: `updateMember` on a fresh
 * enrollment failed with "could not create leading directories of
 * 'C:/Users/.../home/.ion/integration/C:/Users/.../repo-josh/.git'". The old
 * implementation split repoPath on '/' only, so a Windows-native backslash
 * path (as Node's `path.join` produces there) never split at all -- `.pop()`
 * returned the whole absolute path as the "repo name", which then got joined
 * as a slug UNDER another path, embedding a drive letter mid-path.
 */
import { describe, it, expect } from 'vitest'
import { benchSlug } from '../integration/bench-store'

describe('benchSlug', () => {
  it('takes the last path segment on a POSIX-style path', () => {
    expect(benchSlug('/Users/dev/code/ion', 'josh')).toBe('ion-josh')
  })

  it('takes the last path segment on a Windows-native backslash path', () => {
    expect(benchSlug('C:\\Users\\josh\\AppData\\Local\\Temp\\ion-opstate-XYZ\\repo', 'josh')).toBe('repo-josh')
  })

  it('never embeds a drive letter or path separator in the slug', () => {
    const slug = benchSlug('C:\\Users\\josh\\repo', 'josh')
    expect(slug).not.toContain(':')
    expect(slug).not.toContain('\\')
    expect(slug).not.toContain('/')
  })

  it('collapses unsafe branch characters', () => {
    expect(benchSlug('/repo', 'feature/foo bar')).toBe('repo-feature-foo-bar')
  })
})
