/**
 * Pins the duplicate-row fix in the new-tab DirectoryPicker.
 *
 * `openRepoPaths` is derived from each tab's REPORTED directory, and a tab
 * living inside a worktree or a bench reports that path as its "repo".
 * `git worktree list` answers identically from inside any checkout of the
 * repo, so `worktreeInventory` (keyed by whatever the panel queried) holds the
 * same entry set under several keys. The picker's flatMap then rendered every
 * worktree once per key — the operator saw the full list twice — and React
 * warned about duplicate keys, since rows key on the path.
 *
 * The fix is `dedupeByPath`: a directory's identity is its path, whichever
 * repo key surfaced it. Red on the unfixed code: without the dedupe the
 * flatMap emits 2N entries for the aliased fixture below.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { dedupeByPath } from '../TabStripDirectoryPicker'

const wt = (path: string, branch: string) => ({ worktreePath: path, branchName: branch })

describe('dedupeByPath', () => {
  it('collapses the same inventory surfaced under two repo keys', () => {
    // The exact aliasing shape from the bug: the real repo key and a bench
    // key both hold the same worktree set.
    const underRepoKey = [wt('/wt/a', 'wt/a'), wt('/wt/b', 'wt/b')]
    const underBenchKey = [wt('/wt/a', 'wt/a'), wt('/wt/b', 'wt/b')]
    const flat = [
      ...underRepoKey.map((entry) => ({ repo: '/repo', entry })),
      ...underBenchKey.map((entry) => ({ repo: '/home/.ion/integration/repo-main', entry })),
    ]

    const deduped = dedupeByPath(flat, ({ entry }) => entry.worktreePath)

    expect(deduped.map(({ entry }) => entry.worktreePath)).toEqual(['/wt/a', '/wt/b'])
    // First occurrence wins: the row keeps the repo key that surfaced it first.
    expect(deduped[0].repo).toBe('/repo')
  })

  it('keeps distinct paths from different repos intact', () => {
    const flat = [
      { repo: '/repo-one', entry: wt('/wt/a', 'wt/a') },
      { repo: '/repo-two', entry: wt('/wt/c', 'wt/c') },
    ]
    expect(dedupeByPath(flat, ({ entry }) => entry.worktreePath)).toHaveLength(2)
  })

  it('is a no-op on an already-unique list', () => {
    const flat = [wt('/wt/a', 'wt/a'), wt('/wt/b', 'wt/b')]
    expect(dedupeByPath(flat, (e) => e.worktreePath)).toEqual(flat)
  })
})
