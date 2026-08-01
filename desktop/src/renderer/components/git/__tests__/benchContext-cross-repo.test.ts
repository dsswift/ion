/**
 * benchContext — resolving the bench a directory belongs to.
 *
 * ── The defect the cross-repo lookup fixes ──────────────────────────────────
 * `benchWorkspaces` is keyed by REPO path. A bench conversation's tab carries no
 * worktree metadata (a bench is deliberately not enrolled as a member of
 * itself), so the git panel could not resolve its owning repo from the tab and
 * fell back to the bench directory. Looking the workspaces up under that path
 * found nothing, so the panel concluded it was not in a bench: it showed the
 * Graph section a bench must hide, and listed the bench's OWN `git worktree
 * list` -- the main clone included, with no registry behind it, so no source
 * branches, no memberships, every enrollment diamond hollow, and git's ordering
 * instead of the bench's merge order.
 *
 * Searching every loaded repo is what makes a bench self-identifying: the answer
 * no longer depends on already knowing which repo to ask about.
 */
import { describe, it, expect } from 'vitest'
import { resolveBenchContext, resolveBenchContextAcrossRepos } from '../benchContext'
import type { IntegrationWorkspace } from '../../../../shared/types'

const REPO = '/Users/dev/source/ion'
const BENCH = '/Users/dev/.ion/integration/ion-josh'

function workspace(over: Partial<IntegrationWorkspace> = {}): IntegrationWorkspace {
  return {
    repoPath: REPO,
    sourceBranch: 'josh',
    benchPath: BENCH,
    benchBranch: 'ion/bench/josh',
    members: [],
    baseSha: 'abc1234',
    lastBuiltAt: 1,
    ...over,
  }
}

describe('resolveBenchContextAcrossRepos', () => {
  it('finds the bench without being told which repo owns it', () => {
    // The whole point: the caller has only the bench PATH, which is not a key.
    const byRepo = new Map([[REPO, [workspace()]]])

    const hit = resolveBenchContextAcrossRepos(BENCH, byRepo)

    expect(hit).not.toBeNull()
    expect(hit!.repoPath).toBe(REPO)
    expect(hit!.sourceBranch).toBe('josh')
  })

  it('resolves the owning repo, which is what the worktree list must be keyed by', () => {
    // RED before the fix: the panel used the bench path as the repo, so it
    // listed the bench's own checkouts instead of the repo's worktrees.
    const byRepo = new Map([[REPO, [workspace()]]])

    expect(resolveBenchContextAcrossRepos(BENCH, byRepo)!.repoPath).toBe(REPO)
  })

  it('finds a bench belonging to the second repo in the map', () => {
    const other = '/Users/dev/source/other'
    const byRepo = new Map([
      [other, [workspace({ repoPath: other, benchPath: '/benches/other-main', sourceBranch: 'main' })]],
      [REPO, [workspace()]],
    ])

    expect(resolveBenchContextAcrossRepos(BENCH, byRepo)!.repoPath).toBe(REPO)
  })

  it('resolves from a subdirectory of the bench', () => {
    const byRepo = new Map([[REPO, [workspace()]]])
    expect(resolveBenchContextAcrossRepos(`${BENCH}/desktop/src`, byRepo)!.repoPath).toBe(REPO)
  })

  it('returns null for an ordinary worktree, so the panel keeps Changes and Graph', () => {
    const byRepo = new Map([[REPO, [workspace()]]])
    expect(resolveBenchContextAcrossRepos('/Users/dev/.ion/worktrees/ion-a3f1', byRepo)).toBeNull()
  })

  it('returns null for the repo root itself', () => {
    const byRepo = new Map([[REPO, [workspace()]]])
    expect(resolveBenchContextAcrossRepos(REPO, byRepo)).toBeNull()
  })

  it('does not match a sibling whose name merely begins with the bench path', () => {
    // Same failure class the single-repo resolver guards: a bare startsWith
    // would strip Changes from an unrelated worktree doing real work.
    const byRepo = new Map([[REPO, [workspace()]]])
    expect(resolveBenchContextAcrossRepos(`${BENCH}-other`, byRepo)).toBeNull()
  })

  it('returns null on an empty map or empty directory', () => {
    expect(resolveBenchContextAcrossRepos(BENCH, new Map())).toBeNull()
    expect(resolveBenchContextAcrossRepos('', new Map([[REPO, [workspace()]]]))).toBeNull()
  })

  it('agrees with the single-repo resolver when the repo IS known', () => {
    // The cross-repo form is a search over the same predicate, not a second
    // definition of containment.
    const workspaces = [workspace()]
    const byRepo = new Map([[REPO, workspaces]])

    expect(resolveBenchContextAcrossRepos(BENCH, byRepo))
      .toEqual(resolveBenchContext(BENCH, workspaces))
  })

  it('carries the member list through, so the bench banner can name them', () => {
    const members = [{
      worktreePath: '/wt/a', branchName: 'wt/a', enabled: true,
      pin: 'current' as const, merge: 'merged' as const,
      pinnedSha: 'a', pinnedTreeHash: 't', pinnedBaseSha: 'b', currentTreeHash: 't',
    }]
    const byRepo = new Map([[REPO, [workspace({ members })]]])

    expect(resolveBenchContextAcrossRepos(BENCH, byRepo)!.members).toHaveLength(1)
  })
})
