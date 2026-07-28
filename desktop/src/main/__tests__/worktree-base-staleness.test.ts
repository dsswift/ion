/**
 * Base staleness and worktree sync — the SECOND direction of staleness.
 *
 * The system has two staleness signals pointing opposite ways, and conflating
 * them would make both useless:
 *
 *   - BENCH staleness: the worktree moved ahead of what the bench integrated.
 *     Resolved by Update (re-pin + rebuild). Direction: worktree -> bench.
 *   - BASE staleness (this file): the feature branch moved ahead of where the
 *     worktree was cut from. Resolved by Sync (rebase onto the feature tip).
 *     Direction: feature branch -> worktree.
 *
 * Base staleness fires constantly in the parallel workflow — every land by
 * another worktree advances the feature branch — and also when a teammate
 * pushes or the operator commits to the feature branch directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME into the fixture so bench/registry writes never touch the
// developer's real ~/.ion. Per-file env var: vitest runs test FILES
// concurrently in one process, so a shared name lets files clobber each other.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BASE_STALENESS || actual.homedir() }
})

import { appraiseBase } from '../worktree/base-staleness'
import { syncWorktreeFromSource, landWorktree } from '../worktree/integrate'
import { captureContribution } from '../integration/bench-snapshot'
import { rebuildBench } from '../integration/bench-rebuild'
import { makeWorkspace, makeMember } from '../integration/bench-store'
import type { IntegrationMember, IntegrationWorkspace } from '../../shared/types'

const FEATURE = 'josh'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-base-')))
  process.env.ION_TEST_HOME_BASE_STALENESS = join(root, 'home')
  repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf-8' })
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Dev')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'app.txt'), 'shipped\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'trunk')
  git(repo, 'checkout', '-b', FEATURE)
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BASE_STALENESS
  rmSync(root, { recursive: true, force: true })
})

function makeWorktree(name: string): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)
  return { path, branch }
}

function commitIn(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', message)
}

describe('appraiseBase — detects a stale base', () => {
  it('reports a freshly cut worktree as current', async () => {
    const a = makeWorktree('a')

    const base = await appraiseBase(a.path, FEATURE)

    expect(base.needsSync).toBe(false)
    expect(base.behindCount).toBe(0)
  })

  it('detects the feature branch advancing from a direct commit', async () => {
    const a = makeWorktree('a')
    commitIn(a.path, 'mine.txt', 'my work\n', 'my work')
    // The operator commits straight to the feature branch, outside any worktree.
    commitIn(repo, 'hotfix.txt', 'urgent\n', 'hotfix on the feature branch')

    const base = await appraiseBase(a.path, FEATURE)

    expect(base.needsSync).toBe(true)
    expect(base.behindCount).toBe(1)
    expect(base.behindSubjects).toContain('hotfix on the feature branch')
  })

  // The everyday case in parallel development: another worktree landed, so the
  // feature branch moved and every OTHER worktree is now behind.
  it('detects another worktree landing', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    commitIn(b.path, 'b.txt', 'b\n', 'b work')

    // Park the repo root so the land takes the ref-advance path.
    git(repo, 'checkout', '-b', 'parking')
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })

    const baseB = await appraiseBase(b.path, FEATURE)
    expect(baseB.needsSync).toBe(true)
    expect(baseB.behindCount).toBeGreaterThan(0)
  })

  // THE anti-nag property. After an in-place (no-ff) land, the worktree counts
  // as "behind" by the merge commit, but a sync would gain it nothing — its
  // content already matches the feature branch. A badge no sync can clear is a
  // lie, and the operator learns to ignore all of them.
  //
  // This uses the in-place merge path deliberately: the repo root stays checked
  // out on the feature branch (the real operator setup), which is the only path
  // that produces the misleading non-zero behind count. A ref-advance land
  // leaves behind == 0 and cannot trip the nag.
  it('does NOT flag a worktree whose own work just landed via an in-place merge', async () => {
    const a = makeWorktree('a')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    // Repo root remains on FEATURE, so the land merges in place.
    await landWorktree({
      repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE, noFf: true,
    })

    const base = await appraiseBase(a.path, FEATURE)

    // It IS behind by the merge commit …
    expect(base.behindCount).toBeGreaterThan(0)
    // … but syncing would change nothing, so it is not flagged.
    expect(base.needsSync).toBe(false)
  })

  it('reports uncommitted work so the caller can explain why sync is unavailable', async () => {
    const a = makeWorktree('a')
    commitIn(repo, 'moved.txt', 'moved\n', 'feature branch moves')
    writeFileSync(join(a.path, 'wip.txt'), 'in progress\n')

    const base = await appraiseBase(a.path, FEATURE)

    expect(base.needsSync).toBe(true)
    expect(base.hasUncommittedChanges).toBe(true)
  })

  // Fails QUIET, not closed: a wrong "you are stale" badge is noise, unlike the
  // discard appraisal where being wrong destroys work.
  it('stays silent when it cannot tell', async () => {
    const base = await appraiseBase(join(root, 'nonexistent'), FEATURE)

    expect(base.needsSync).toBe(false)
    expect(base.appraisalFailed).toBe(true)
  })
})

describe('syncWorktreeFromSource — resolves base staleness', () => {
  it('clears the stale signal and brings in the landed work', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    commitIn(b.path, 'b.txt', 'b\n', 'b work')
    git(repo, 'checkout', '-b', 'parking')
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    expect((await appraiseBase(b.path, FEATURE)).needsSync).toBe(true)

    const result = await syncWorktreeFromSource(b.path, FEATURE)

    expect(result.ok).toBe(true)
    // The signal cleared — proving the badge was actionable.
    expect((await appraiseBase(b.path, FEATURE)).needsSync).toBe(false)
    // B now develops against A's landed work …
    expect(existsSync(join(b.path, 'a.txt'))).toBe(true)
    // … and keeps its own.
    expect(readFileSync(join(b.path, 'b.txt'), 'utf-8')).toBe('b\n')
  })

  // Data safety: a sync must never eat in-progress work.
  it('refuses a dirty worktree with an actionable message and touches nothing', async () => {
    const a = makeWorktree('a')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    commitIn(repo, 'moved.txt', 'moved\n', 'feature branch moves')

    writeFileSync(join(a.path, 'a.txt'), 'UNCOMMITTED EDIT\n')
    writeFileSync(join(a.path, 'untracked.txt'), 'new file\n')
    const headBefore = git(a.path, 'rev-parse', 'HEAD').trim()

    const result = await syncWorktreeFromSource(a.path, FEATURE)

    expect(result.ok).toBe(false)
    expect(result.refusedDirty).toBe(true)
    expect(result.error).toMatch(/uncommitted changes/i)
    expect(result.error).toMatch(/not been touched/i)
    // Every byte of in-progress work survives, and HEAD did not move.
    expect(readFileSync(join(a.path, 'a.txt'), 'utf-8')).toBe('UNCOMMITTED EDIT\n')
    expect(readFileSync(join(a.path, 'untracked.txt'), 'utf-8')).toBe('new file\n')
    expect(git(a.path, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
  })

  it('reports a conflict with recovery instructions', async () => {
    const a = makeWorktree('a')
    commitIn(a.path, 'shared.txt', 'from the worktree\n', 'worktree edit')
    commitIn(repo, 'shared.txt', 'from the feature branch\n', 'feature branch edit')

    const result = await syncWorktreeFromSource(a.path, FEATURE)

    expect(result.ok).toBe(false)
    expect(result.hasConflicts).toBe(true)
    expect(result.error).toMatch(/rebase --abort/)
  })
})

describe('the two staleness directions are independent', () => {
  // Both can be true at once and each has its own resolution. Proving they do
  // not interfere is what stops one signal from masking the other.
  it('tracks bench staleness and base staleness separately', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    commitIn(b.path, 'b.txt', 'b v1\n', 'b work')

    async function enroll(wt: { path: string; branch: string }): Promise<IntegrationMember> {
      const c = await captureContribution(wt.path, FEATURE, wt.branch)
      return makeMember({
        worktreePath: wt.path,
        branchName: wt.branch,
        pinnedSha: c.sha,
        pinnedTreeHash: c.treeHash,
        pinnedBaseSha: c.baseSha,
      })
    }
    const wsBase = makeWorkspace(repo, FEATURE)
    const ws: IntegrationWorkspace = {
      ...wsBase,
      benchPath: join(root, 'bench'),
      benchBranch: `ion/bench/${FEATURE}`,
      members: [await enroll(a), await enroll(b)],
    }
    const built = (await rebuildBench(ws)).workspace!

    // Direction 1 — B commits more: BENCH is stale for B, base is not.
    commitIn(b.path, 'b.txt', 'b v2\n', 'b more work')
    const bMember = built.members.find((m) => m.branchName === b.branch)!
    const bNow = await captureContribution(b.path, FEATURE, b.branch)
    expect(bNow.treeHash).not.toBe(bMember.pinnedTreeHash)   // bench stale
    expect((await appraiseBase(b.path, FEATURE)).needsSync).toBe(false)  // base fine

    // Direction 2 — A lands: BASE is now stale for B as well.
    git(repo, 'checkout', '-b', 'parking')
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    expect((await appraiseBase(b.path, FEATURE)).needsSync).toBe(true)

    // Resolving BASE staleness (sync) does not re-pin the bench: B's
    // contribution still differs from what the bench integrated.
    const synced = await syncWorktreeFromSource(b.path, FEATURE)
    expect(synced.ok).toBe(true)
    expect((await appraiseBase(b.path, FEATURE)).needsSync).toBe(false)
    const bAfterSync = await captureContribution(b.path, FEATURE, b.branch)
    expect(bAfterSync.treeHash).not.toBe(bMember.pinnedTreeHash)  // still bench-stale

    // Resolving BENCH staleness (re-pin + rebuild) integrates B's new work.
    const updated = {
      ...built,
      members: built.members.map((m) => (m.branchName === b.branch
        ? { ...m, pinnedSha: bAfterSync.sha, pinnedTreeHash: bAfterSync.treeHash }
        : m)),
    }
    const result = await rebuildBench(updated)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(ws.benchPath, 'b.txt'), 'utf-8')).toBe('b v2\n')
  })
})
