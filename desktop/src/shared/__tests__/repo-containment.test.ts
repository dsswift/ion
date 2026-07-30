/**
 * Repo-containment predicate.
 *
 * The conflict banner used to decide which alerts belong to the open project
 * with `dir.includes(repoPath)` — a substring match on an absolute path, so a
 * repo at `/src/ion` claimed alerts from `/src/ion-other` and raised a banner
 * for an unrelated project's conflict.
 *
 * Consequence was bounded (a spurious row, never a wrong git action), but the
 * codebase already carried the correct separator rule in three places, each
 * with a comment explaining that a bare prefix test matches `ion-a33725460`
 * against `ion-a3372546`. This pins that rule.
 *
 * Regression direction: reverting to `includes` turns the sibling and
 * substring cases red; dropping the separator from the descendant check turns
 * the sibling cases red.
 */
import { describe, it, expect } from 'vitest'
import { isWithinRepo } from '../repo-containment'

const REPO = '/Users/dev/src/ion'

describe('isWithinRepo', () => {
  it('matches the root itself', () => {
    expect(isWithinRepo(REPO, REPO)).toBe(true)
  })

  it('matches a directory beneath the root', () => {
    expect(isWithinRepo(`${REPO}/desktop/src`, REPO)).toBe(true)
  })

  // THE case the substring match got wrong.
  it('does NOT match a sibling whose name merely begins with the root', () => {
    expect(isWithinRepo('/Users/dev/src/ion-other', REPO)).toBe(false)
    expect(isWithinRepo('/Users/dev/src/ion-other/worktree', REPO)).toBe(false)
  })

  it('does NOT match a path that merely contains the root mid-string', () => {
    expect(isWithinRepo('/backups/Users/dev/src/ion-copy', REPO)).toBe(false)
  })

  it('does not match an unrelated directory', () => {
    expect(isWithinRepo('/Users/dev/.ion/worktrees/proj-a1', REPO)).toBe(false)
  })

  it('is false for empty inputs rather than matching everything', () => {
    expect(isWithinRepo('', REPO)).toBe(false)
    expect(isWithinRepo(REPO, '')).toBe(false)
  })
})
