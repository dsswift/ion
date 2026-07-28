/**
 * Mid-operation worktrees — the conflicted-rebase state, against REAL git.
 *
 * ── The incident these tests pin ────────────────────────────────────────────
 * A "Sync from josh" hit a real conflict. The rebase stopped halfway, leaving
 * the worktree in detached HEAD at the rebase's transient position. Two
 * defects followed:
 *
 *   A. The inventory skipped detached-HEAD entries, so the worktree VANISHED
 *      from the Worktrees panel — at the exact moment the operator needed to
 *      see it and resolve the conflict.
 *   B. The bench read HEAD for the member's contribution, pinned the rebase's
 *      transient position (== the source tip), computed an empty range, and
 *      reported `no commits yet` for a branch holding real commits.
 *
 * Real repos, not mocks: the behavior under test IS git's mid-rebase state
 * layout (.git/worktrees/<id>/rebase-merge/), which a mock would just restate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME so registry reads/writes land in the fixture. Per-file env var:
// vitest runs test FILES concurrently in one process.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_WT_OPSTATE || actual.homedir() }
})

import { inventoryWorktrees, registerWorktree } from '../worktree/inventory'
import { probeOperationState, unmergedPaths } from '../git/operation-state'
import { captureContribution, contributedTreeHash } from '../integration/bench-snapshot'
import { syncWorktreeFromSource } from '../worktree/integrate'
import { refreshStaleness, updateMember, ensureWorkspace, addMember } from '../integration/bench-ops'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

const FEATURE = 'josh'

function makeRepo(): string {
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf-8' })
  git(dir, 'config', 'user.email', 'dev@example.com')
  git(dir, 'config', 'user.name', 'Dev')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'shared.txt'), 'line1\nline2\nline3\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  git(dir, 'branch', FEATURE)
  // Park the repo root off the feature branch so worktrees can hold it.
  git(dir, 'checkout', '-b', 'parking')
  return dir
}

/**
 * A worktree whose branch edits `shared.txt`, plus a conflicting edit landed on
 * the feature branch afterwards — the exact shape whose sync-rebase conflicts.
 */
function makeConflictingWorktree(name: string): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)
  writeFileSync(join(path, 'shared.txt'), 'line1\nWORKTREE CHANGE\nline3\n')
  git(path, 'add', '-A')
  git(path, 'commit', '-m', `${name}: edit shared`)
  registerWorktree({ worktreePath: path, repoPath: repo, branchName: branch, sourceBranch: FEATURE })

  // Land a conflicting edit on the feature branch (via a throwaway holder
  // worktree, since the repo root is parked).
  const holder = join(root, `${name}-holder`)
  git(repo, 'worktree', 'add', holder, FEATURE)
  writeFileSync(join(holder, 'shared.txt'), 'line1\nFEATURE CHANGE\nline3\n')
  git(holder, 'add', '-A')
  git(holder, 'commit', '-m', 'feature: conflicting edit')
  git(repo, 'worktree', 'remove', '--force', holder)

  return { path, branch }
}

/** Drive the worktree into the stuck mid-rebase state via the real sync verb. */
async function strandMidRebase(wt: { path: string; branch: string }): Promise<void> {
  const result = await syncWorktreeFromSource(wt.path, FEATURE)
  expect(result.ok).toBe(false)
  expect(result.hasConflicts).toBe(true)
  // The state the incident left behind: detached HEAD, rebase in progress.
  expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-opstate-')))
  process.env.ION_TEST_HOME_WT_OPSTATE = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_WT_OPSTATE
  rmSync(root, { recursive: true, force: true })
})

describe('probeOperationState — reading git state via --git-path', () => {
  it('reports none for a quiescent worktree', async () => {
    const wt = makeConflictingWorktree('a')
    const probe = await probeOperationState(wt.path)
    expect(probe.state).toBeUndefined()
    expect(probe.conflictedPaths).toEqual([])
  })

  it('reports a conflicted rebase with its branch, onto, and paths', async () => {
    const wt = makeConflictingWorktree('a')
    await strandMidRebase(wt)

    const probe = await probeOperationState(wt.path)
    expect(probe.state).toBe('rebasing')
    // The branch git recorded in rebase-merge/head-name — what keeps the
    // worktree identifiable while HEAD is detached.
    expect(probe.branch).toBe(wt.branch)
    expect(probe.conflictedPaths).toEqual(['shared.txt'])
  })

  it('unmergedPaths dedupes the per-stage lines to paths', async () => {
    const wt = makeConflictingWorktree('a')
    await strandMidRebase(wt)
    // ls-files --unmerged prints one line per stage (up to 3 per path).
    expect(await unmergedPaths(wt.path)).toEqual(['shared.txt'])
  })
})

describe('inventory — a mid-rebase worktree stays visible (Defect A)', () => {
  it('keeps the entry with its branch, operation, and conflicted paths', async () => {
    // RED before the fix: the detached-HEAD skip dropped this entry entirely.
    const wt = makeConflictingWorktree('a')
    await strandMidRebase(wt)

    const entries = await inventoryWorktrees(repo)
    const entry = entries.find((e) => e.worktreePath === wt.path)

    expect(entry).toBeDefined()
    expect(entry!.branchName).toBe(wt.branch)
    expect(entry!.operationState).toBe('rebasing')
    expect(entry!.conflictedPaths).toEqual(['shared.txt'])
  })

  it('still skips a genuinely detached worktree with no operation', async () => {
    // An operator checkout of a bare sha is not a managed feature worktree;
    // recovering mid-operation entries must not start listing those.
    const path = join(root, 'detached')
    git(repo, 'worktree', 'add', '--detach', path, FEATURE)

    const entries = await inventoryWorktrees(repo)
    expect(entries.find((e) => e.worktreePath === path)).toBeUndefined()
  })

  it('reports a quiescent worktree with no operationState', async () => {
    const wt = makeConflictingWorktree('a')
    const entries = await inventoryWorktrees(repo)
    const entry = entries.find((e) => e.worktreePath === wt.path)
    expect(entry).toBeDefined()
    expect(entry!.operationState).toBeUndefined()
    expect(entry!.conflictedPaths).toBeUndefined()
  })
})

describe('bench capture — the branch ref, not HEAD (Defect B)', () => {
  it('captures the branch tip mid-rebase, not the transient rebase HEAD', async () => {
    // RED before the fix: captureContribution read HEAD, which mid-rebase is
    // the rebase position (== feature tip after the conflicting land), giving
    // sha == base and an empty contribution for a branch with a real commit.
    const wt = makeConflictingWorktree('a')
    const branchTip = git(wt.path, 'rev-parse', wt.branch).trim()
    await strandMidRebase(wt)

    const c = await captureContribution(wt.path, FEATURE, wt.branch)

    expect(c.sha).toBe(branchTip)
    expect(c.baseSha).not.toBe(c.sha) // the contribution range is NOT empty
  })

  it('contributedTreeHash mid-rebase equals the branch tree', async () => {
    const wt = makeConflictingWorktree('a')
    const branchTree = git(wt.path, 'rev-parse', `${wt.branch}^{tree}`).trim()
    await strandMidRebase(wt)

    const member = {
      worktreePath: wt.path, branchName: wt.branch, label: 'a', enabled: true,
      pinnedSha: 'x', pinnedTreeHash: 'x', pinnedBaseSha: 'x', currentTreeHash: 'x',
      status: 'integrated' as const,
    }
    expect(await contributedTreeHash(member)).toBe(branchTree)
  })

  it('a mid-rebase member does not go pending; staleness reads the branch', async () => {
    // The live-record scenario end to end: enroll, get stranded mid-rebase,
    // refresh staleness — the member must keep describing its BRANCH content,
    // not flip to an empty pin. Then Update re-pins the real contribution.
    const wt = makeConflictingWorktree('a')
    ensureWorkspace(repo, FEATURE)
    const added = await addMember(repo, FEATURE, wt.path, wt.branch)
    expect(added.ok).toBe(true)

    await strandMidRebase(wt)

    const refreshed = await refreshStaleness(repo, FEATURE)
    const member = refreshed!.members.find((m) => m.branchName === wt.branch)!
    // The branch has not moved, so the member is exactly as integrated as it
    // was at enrollment — the rebase in the working tree changes nothing.
    expect(member.status).toBe('integrated')
    expect(member.currentTreeHash).toBe(member.pinnedTreeHash)

    // Update mid-rebase still pins the branch contribution, never the
    // transient HEAD (updateMember rebuilds, which is fine in the fixture).
    const updated = await updateMember(repo, FEATURE, wt.path)
    expect(updated.ok).toBe(true)
    const after = updated.workspace!.members.find((m) => m.branchName === wt.branch)!
    expect(after.pinnedSha).toBe(git(wt.path, 'rev-parse', wt.branch).trim())
    expect(after.pinnedBaseSha).not.toBe(after.pinnedSha)
  })
})
