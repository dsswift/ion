/**
 * Landed absorption — what happens to a bench member when its work lands into
 * the source branch.
 *
 * The operator's flow: "Land & retire" / "Land & close" merges a worktree into
 * the feature branch. From that moment the work is PERMANENTLY part of the
 * feature branch, so it must be part of the bench without option — the bench is
 * rebuilt from the source tip, so it arrives with the base.
 *
 * Two properties matter and both are pinned here:
 *   1. The landed content is present in the bench with NO merge commit of its
 *      own (it came with the base).
 *   2. The member record is retired, and disabling it cannot remove the
 *      content — because there is no merge to skip.
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
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_LANDED || actual.homedir() }
})

import { rebuildBench } from '../integration/bench-rebuild'
import { captureContribution } from '../integration/bench-snapshot'
import { makeWorkspace, makeMember } from '../integration/bench-store'
import { landWorktree } from '../worktree/integrate'
import { retireWorktree } from '../worktree/relocate'
import type { IntegrationWorkspace, IntegrationMember } from '../../shared/types'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

/**
 * A repo shaped like the operator's: a long-lived trunk (`main`) plus the
 * FEATURE branch that worktrees actually land into. The workspace's source
 * branch is the feature branch — nothing here lands into main, which happens
 * later via a pull request from the feature branch.
 */
const FEATURE = 'josh'

function makeRepo(): string {
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf-8' })
  git(dir, 'config', 'user.email', 'dev@example.com')
  git(dir, 'config', 'user.name', 'Dev')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  // The feature branch the operator works on, cut from main.
  git(dir, 'branch', FEATURE)
  // Park the repo root off the feature branch so lands take the zero-impact
  // ref-advance path and never contend with the bench worktree for it.
  git(dir, 'checkout', '-b', 'parking')
  return dir
}

/** A worktree with NO seed commit, for tests that count commits exactly. */
function makeBareWorktree(name: string): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)
  return { path, branch }
}

function makeWorktree(name: string, file = `${name}.txt`): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)
  writeFileSync(join(path, file), `${name}\n`)
  git(path, 'add', '-A')
  git(path, 'commit', '-m', `${name} work`)
  return { path, branch }
}

function workspaceFor(members: IntegrationMember[] = []): IntegrationWorkspace {
  const ws = makeWorkspace(repo, FEATURE)
  return { ...ws, benchPath: join(root, 'bench'), benchBranch: `ion/bench/${FEATURE}`, members }
}

async function enroll(wt: { path: string; branch: string }): Promise<IntegrationMember> {
  const c = await captureContribution(wt.path, FEATURE)
  return makeMember({
    worktreePath: wt.path,
    branchName: wt.branch,
    pinnedSha: c.sha,
    pinnedTreeHash: c.treeHash,
    pinnedBaseSha: c.baseSha,
  })
}

function benchMergeCount(benchPath: string): number {
  const out = git(benchPath, 'log', '--merges', '--format=%H', `${FEATURE}..HEAD`).trim()
  return out ? out.split('\n').length : 0
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-landed-')))
  process.env.ION_TEST_HOME_BENCH_LANDED = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_LANDED
  rmSync(root, { recursive: true, force: true })
})

describe('landed absorption — the member worktree is never modified', () => {
  // "Absorption" is a bookkeeping change to the BENCH's member list. It must
  // never touch the worktree, its branch, or its commits. The operator's
  // worktree is theirs: after landing four commits, all four are still on the
  // branch, the branch still exists, and the directory is untouched.
  it('leaves all landed commits on the worktree branch after absorption', async () => {
    // Bare worktree: this test counts commits exactly, so it does not use the
    // helper's seed commit.
    const a = makeBareWorktree('a')
    // Four commits, the shape the operator described.
    for (const n of [1, 2, 3, 4]) {
      writeFileSync(join(a.path, `c${n}.txt`), `${n}\n`)
      git(a.path, 'add', '-A')
      git(a.path, 'commit', '-m', `commit ${n}`)
    }
    const ws = workspaceFor([await enroll(a)])
    const built = (await rebuildBench(ws)).workspace!

    const headBefore = git(a.path, 'rev-parse', 'HEAD').trim()
    const logBefore = git(a.path, 'log', '--format=%s', `${FEATURE}..HEAD`)
    const statusBefore = git(a.path, 'status', '--porcelain')
    const reflogBefore = git(a.path, 'reflog', 'show', a.branch)

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    const result = await rebuildBench(built)

    // The bench retired the member record …
    expect(result.retired!.map((m) => m.status)).toEqual(['landed'])
    // … and the worktree is completely unchanged.
    expect(existsSync(a.path)).toBe(true)
    expect(git(a.path, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(git(a.path, 'status', '--porcelain')).toBe(statusBefore)
    expect(git(a.path, 'reflog', 'show', a.branch)).toBe(reflogBefore)
    // The branch still exists with all four commits on it.
    expect(git(repo, 'branch', '--list', a.branch).trim()).toContain(a.branch)
    expect(git(a.path, 'log', '--format=%s', '-4').trim().split('\n')).toEqual([
      'commit 4', 'commit 3', 'commit 2', 'commit 1',
    ])
    // Every file from every commit is still on disk.
    for (const n of [1, 2, 3, 4]) {
      expect(existsSync(join(a.path, `c${n}.txt`))).toBe(true)
    }
    // The pre-land commit list is unchanged — landing moved the commits INTO
    // main, it did not take them out of the branch.
    expect(logBefore.trim().split('\n')).toEqual(['commit 4', 'commit 3', 'commit 2', 'commit 1'])
    // And the same four are still ahead of the branch's start point.
    expect(git(a.path, 'log', '--format=%s', `${headBefore}~4..${headBefore}`).trim().split('\n'))
      .toEqual(['commit 4', 'commit 3', 'commit 2', 'commit 1'])
  })

  it('leaves uncommitted work in the worktree untouched when an earlier commit lands', async () => {
    const a = makeBareWorktree('a')
    writeFileSync(join(a.path, 'done.txt'), 'ready\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'ready work')
    const ws = workspaceFor([await enroll(a)])
    const built = (await rebuildBench(ws)).workspace!

    // The agent keeps working after the land.
    writeFileSync(join(a.path, 'in-progress.txt'), 'still editing\n')

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    await rebuildBench(built)

    expect(readFileSync(join(a.path, 'in-progress.txt'), 'utf-8')).toBe('still editing\n')
    expect(git(a.path, 'status', '--porcelain')).toContain('in-progress.txt')
  })

  it('can continue working in the worktree after its member was retired', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'first.txt'), 'first\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'first')
    const ws = workspaceFor([await enroll(a)])
    const built = (await rebuildBench(ws)).workspace!

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    const afterLand = (await rebuildBench(built)).workspace!
    expect(afterLand.members).toHaveLength(0)

    // The worktree is still fully usable: commit more work and re-enroll it.
    writeFileSync(join(a.path, 'second.txt'), 'second\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'second round')
    const reEnrolled = { ...afterLand, members: [await enroll(a)] }

    const result = await rebuildBench(reEnrolled)

    expect(result.ok).toBe(true)
    expect(result.workspace!.members.map((m) => m.branchName)).toEqual(['wt/a'])
    expect(existsSync(join(ws.benchPath, 'second.txt'))).toBe(true)
    // Both rounds of work are present in the bench.
    expect(existsSync(join(ws.benchPath, 'first.txt'))).toBe(true)
  })
})

describe('landed member absorption', () => {
  it('keeps landed content in the bench with no merge commit, and retires the member', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await rebuildBench(ws)).workspace!
    expect(benchMergeCount(ws.benchPath)).toBe(2)

    // Land A into main (the "Land & retire" path).
    const landed = await landWorktree({
      repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE,
    })
    expect(landed.ok).toBe(true)

    const result = await rebuildBench(built)

    expect(result.ok).toBe(true)
    // A's content is still in the bench — it arrived with the base.
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
    // …but it no longer needs a merge commit of its own. Only B is merged.
    expect(benchMergeCount(ws.benchPath)).toBe(1)
    // A is retired from the member list and reported as landed.
    expect(result.workspace!.members.map((m) => m.branchName)).toEqual(['wt/b'])
    expect(result.retired!.map((m) => m.branchName)).toEqual(['wt/a'])
    expect(result.retired![0].status).toBe('landed')
  })

  // The "without option" part of the requirement: once landed, the work is part
  // of the feature branch, so no bench control can take it out.
  it('cannot be removed by disabling the member', async () => {
    const a = makeWorktree('a')
    const ws = workspaceFor([await enroll(a)])
    const built = (await rebuildBench(ws)).workspace!

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })

    // Operator disables the member and rebuilds.
    const disabled = { ...built, members: built.members.map((m) => ({ ...m, enabled: false })) }
    const result = await rebuildBench(disabled)

    expect(result.ok).toBe(true)
    // Content is still there: it is part of the base now.
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
    // It reports `landed`, not `excluded` — reporting excluded would be a lie
    // about content that is demonstrably present.
    expect(result.retired!.map((m) => m.status)).toEqual(['landed'])
    expect(result.workspace!.members).toHaveLength(0)
  })

  it('absorbs a member landed via a no-ff merge commit', async () => {
    const a = makeWorktree('a')
    const ws = workspaceFor([await enroll(a)])
    const built = (await rebuildBench(ws)).workspace!

    await landWorktree({
      repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE, noFf: true,
    })

    const result = await rebuildBench(built)

    expect(result.ok).toBe(true)
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
    expect(benchMergeCount(ws.benchPath)).toBe(0)
    expect(result.retired!.map((m) => m.branchName)).toEqual(['wt/a'])
  })

  // The full operator sequence: land, retire the worktree, rebuild. The bench
  // must still contain the work even though the worktree is gone.
  it('survives the worktree being retired after the land', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await rebuildBench(ws)).workspace!

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    const retiredWt = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch })
    expect(retiredWt.ok).toBe(true)
    expect(existsSync(a.path)).toBe(false)

    const result = await rebuildBench(built)

    expect(result.ok).toBe(true)
    // Landed content survives the worktree AND the branch being deleted,
    // because it lives in the source branch now — not reported `missing`.
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
    expect(result.retired!.map((m) => m.status)).toEqual(['landed'])
    expect(result.workspace!.members.map((m) => m.branchName)).toEqual(['wt/b'])
  })

  it('leaves an unlanded member alone', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await rebuildBench(ws)).workspace!

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })

    const result = await rebuildBench(built)

    // B is untouched: still a member, still merged, still pinned where it was.
    const bAfter = result.workspace!.members.find((m) => m.branchName === 'wt/b')!
    expect(bAfter.status).toBe('integrated')
    expect(bAfter.pinnedSha).toBe(built.members.find((m) => m.branchName === 'wt/b')!.pinnedSha)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(true)
  })

  // Partial landing: the operator landed the first commit of a member's work
  // and kept going. The member is NOT retired, because its pin is not contained
  // in the source branch.
  it('does not retire a member whose later commits have not landed', async () => {
    const a = makeWorktree('a')
    const firstPin = await enroll(a)
    const ws = workspaceFor([firstPin])
    await rebuildBench(ws)

    // Land the first commit, then do more work and advance the pin.
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    writeFileSync(join(a.path, 'a2.txt'), 'more\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a more work')
    const advanced = await enroll(a)
    const updated = { ...ws, members: [{ ...ws.members[0], ...advanced }] }

    const result = await rebuildBench(updated)

    expect(result.ok).toBe(true)
    expect(result.retired ?? []).toHaveLength(0)
    expect(result.workspace!.members.map((m) => m.branchName)).toEqual(['wt/a'])
    expect(existsSync(join(ws.benchPath, 'a2.txt'))).toBe(true)
  })
})

describe('landed absorption — rewritten history (squash, rebase, cherry-pick)', () => {
  // THE case a sha-based check misses. The operator produces dozens of
  // stream-of-consciousness commits while testing, squashes them into a tight
  // set, then lands. The squashed commit is a NEW sha, so the pinned
  // (pre-squash) sha is not an ancestor of the feature branch — but every line
  // of its content is now there. Without content-based detection the bench
  // re-merges work already in its base.
  it('absorbs a member squashed before landing', async () => {
    const a = makeBareWorktree('a')
    // A stream of consciousness.
    for (const n of [1, 2, 3, 4, 5, 6]) {
      writeFileSync(join(a.path, 'feature.txt'), `revision ${n}\n`)
      git(a.path, 'add', '-A')
      git(a.path, 'commit', '-m', `wip ${n}`)
    }
    const ws = workspaceFor([await enroll(a)])
    const built = (await rebuildBench(ws)).workspace!
    const prePin = built.members[0].pinnedSha

    // Squash into one tight commit, then land it.
    git(a.path, 'reset', '--soft', FEATURE)
    git(a.path, 'commit', '-m', 'feat: the real feature')
    const squashedSha = git(a.path, 'rev-parse', 'HEAD').trim()
    expect(squashedSha).not.toBe(prePin)
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })

    const result = await rebuildBench(built)

    // Absorbed despite the pinned sha no longer existing in the feature branch.
    expect(result.retired!.map((m) => m.status)).toEqual(['landed'])
    expect(result.workspace!.members).toHaveLength(0)
    // The content is present, and it came from the BASE — no merge commit.
    expect(readFileSync(join(ws.benchPath, 'feature.txt'), 'utf-8')).toBe('revision 6\n')
    expect(benchMergeCount(ws.benchPath)).toBe(0)
  })

  it('absorbs a member rebased before landing', async () => {
    const a = makeBareWorktree('a')
    writeFileSync(join(a.path, 'feature.txt'), 'my work\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'my work')
    const ws = workspaceFor([await enroll(a)])
    const built = (await rebuildBench(ws)).workspace!

    // The feature branch moves on, the member rebases onto it (new sha), lands.
    const other = makeWorktree('other')
    await landWorktree({ repoPath: repo, worktreePath: other.path, worktreeBranch: other.branch, sourceBranch: FEATURE })
    git(a.path, 'rebase', FEATURE)
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })

    const result = await rebuildBench(built)

    const retiredBranches = result.retired!.map((m) => m.branchName)
    expect(retiredBranches).toContain('wt/a')
    expect(readFileSync(join(ws.benchPath, 'feature.txt'), 'utf-8')).toBe('my work\n')
  })

  it('absorbs a member landed by cherry-pick', async () => {
    const a = makeBareWorktree('a')
    writeFileSync(join(a.path, 'feature.txt'), 'picked work\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'picked work')
    const ws = workspaceFor([await enroll(a)])
    const built = (await rebuildBench(ws)).workspace!

    // Land by cherry-pick: a different sha carrying the same patch.
    const featureWt = join(root, 'feature-checkout')
    git(repo, 'worktree', 'add', featureWt, FEATURE)
    git(featureWt, 'cherry-pick', a.branch)

    const result = await rebuildBench(built)

    expect(result.retired!.map((m) => m.status)).toEqual(['landed'])
    expect(readFileSync(join(ws.benchPath, 'feature.txt'), 'utf-8')).toBe('picked work\n')
  })

  // The bench must remain functionally identical across a land: same content,
  // just sourced from the base instead of the worktree.
  it('leaves the bench tree byte-identical across a squash-and-land', async () => {
    const a = makeBareWorktree('a')
    for (const n of [1, 2, 3]) {
      writeFileSync(join(a.path, 'feature.txt'), `rev ${n}\n`)
      git(a.path, 'add', '-A')
      git(a.path, 'commit', '-m', `wip ${n}`)
    }
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await rebuildBench(ws)).workspace!
    const treeBefore = git(ws.benchPath, 'rev-parse', 'HEAD^{tree}').trim()

    git(a.path, 'reset', '--soft', FEATURE)
    git(a.path, 'commit', '-m', 'feat: squashed')
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })

    const result = await rebuildBench(built)

    expect(result.ok).toBe(true)
    // Identical CONTENT — the whole point: functionally the same bench, now
    // sourcing A from the base and B from its worktree.
    expect(git(ws.benchPath, 'rev-parse', 'HEAD^{tree}').trim()).toBe(treeBefore)
    // One merge remains: B. A came with the base.
    expect(benchMergeCount(ws.benchPath)).toBe(1)
    expect(result.workspace!.members.map((m) => m.branchName)).toEqual(['wt/b'])
  })

  // The squash rewrites history in the worktree, but that is the OPERATOR's
  // action. Absorption itself must still not touch anything.
  it('does not touch the worktree when absorbing a squashed member', async () => {
    const a = makeBareWorktree('a')
    for (const n of [1, 2]) {
      writeFileSync(join(a.path, 'feature.txt'), `rev ${n}\n`)
      git(a.path, 'add', '-A')
      git(a.path, 'commit', '-m', `wip ${n}`)
    }
    const ws = workspaceFor([await enroll(a)])
    const built = (await rebuildBench(ws)).workspace!

    git(a.path, 'reset', '--soft', FEATURE)
    git(a.path, 'commit', '-m', 'feat: squashed')
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })

    const headBefore = git(a.path, 'rev-parse', 'HEAD').trim()
    const statusBefore = git(a.path, 'status', '--porcelain')

    await rebuildBench(built)

    expect(existsSync(a.path)).toBe(true)
    expect(git(a.path, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(git(a.path, 'status', '--porcelain')).toBe(statusBefore)
    expect(git(repo, 'branch', '--list', a.branch).trim()).toContain(a.branch)
  })
})

/**
 * A member enrolled before it has committed anything.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * A worktree cut from the feature branch and enrolled before its first commit
 * has a HEAD identical to the feature-branch tip. Every landed-detection tier
 * then answers "landed": the pinned commit IS an ancestor of the source branch,
 * the pinned tree IS in its history, and the branch does NOT differ from it. So
 * the member was absorbed and retired on every rebuild, and the operator could
 * never keep it enrolled.
 *
 * Landing and never-started are indistinguishable by any live git query, which
 * is why the contribution is recorded as a RANGE at pin time. These tests pin
 * both halves: the empty member survives, and a genuinely landed member is still
 * retired.
 */
