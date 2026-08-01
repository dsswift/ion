/**
 * The contribution RANGE — telling "not started" apart from "landed".
 *
 * A member's contribution is `pinnedBaseSha..pinnedSha`, not the tip. That
 * distinction exists because a worktree enrolled before its first commit has a
 * HEAD identical to the feature-branch tip, so every landed-detection tier
 * answers yes: the pinned commit IS an ancestor of the source branch, its tree IS
 * in that history, and the branch does NOT differ from it. The bench read that as
 * landed and retired the member on every rebuild, so a freshly-cut worktree could
 * never stay enrolled.
 *
 * Landing and never-started are indistinguishable by any live git query, which is
 * why the range is recorded when the pin is taken. Pinned here:
 *   1. An empty contribution is `pending` — kept, never merged, never retired.
 *   2. A pin that really carried commits is still absorbed and retired.
 *   3. Legacy records with no recorded range resolve correctly either way.
 *
 * Split from bench-landed.test.ts to stay under the file-size cap; the fixture
 * helpers are duplicated deliberately rather than shared, so each file's HOME
 * redirect stays independent (vitest runs files concurrently in one process).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME into the fixture so bench/registry writes never touch the
// developer's real ~/.ion. Per-file env var: vitest runs test FILES
// concurrently in one process, so a shared name lets files clobber each other.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_PENDING || actual.homedir() }
})

import { rebuildBench } from '../integration/bench-rebuild'
import { captureContribution } from '../integration/bench-snapshot'
import { makeWorkspace, makeMember } from '../integration/bench-store'
import { landWorktree } from '../worktree/integrate'
import { retireWorktree } from '../worktree/relocate'
import type { IntegrationWorkspace, IntegrationMember } from '../../shared/types'
import { GIT_FIXTURE_TIMEOUT } from '../../test/git-fixture-timeout'

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
  const c = await captureContribution(wt.path, FEATURE, wt.branch)
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
  process.env.ION_TEST_HOME_BENCH_PENDING = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_PENDING
  rmSync(root, { recursive: true, force: true })
})

describe('rebuildBench — a member with nothing committed yet', () => {
  it('keeps the member as pending instead of retiring it', async () => {
    // makeBareWorktree has NO seed commit, so its HEAD is the FEATURE tip —
    // exactly the shape that used to be misread as landed.
    const a = makeBareWorktree('a')
    const ws = workspaceFor([await enroll(a)])

    const result = await rebuildBench(ws)
    expect(result.ok).toBe(true)

    // The assertion that goes red without the fix: the member is retired there.
    const member = result.workspace!.members.find((m) => m.branchName === a.branch)
    expect(member).toBeDefined()
    expect(member!.status).toBe('pending')
    expect((result.retired ?? []).map((m) => m.branchName)).not.toContain(a.branch)
  })

  it('survives repeated rebuilds', async () => {
    // The report was "it removes it every time" — one rebuild is not enough to
    // pin this.
    const a = makeBareWorktree('a')
    let ws = workspaceFor([await enroll(a)])
    for (let i = 0; i < 3; i++) {
      const result = await rebuildBench(ws)
      expect(result.workspace!.members).toHaveLength(1)
      expect(result.workspace!.members[0].status).toBe('pending')
      ws = result.workspace!
    }
  })

  it('contributes no merge commit while pending', async () => {
    // Pending means "nothing to merge", not "merge an empty change".
    const a = makeBareWorktree('a')
    const built = (await rebuildBench(workspaceFor([await enroll(a)]))).workspace!
    expect(benchMergeCount(built.benchPath)).toBe(0)
  })

  it('does not block the rest of the bench from building', async () => {
    const empty = makeBareWorktree('empty')
    const real = makeWorktree('real')
    const ws = workspaceFor([await enroll(empty), await enroll(real)])

    const built = (await rebuildBench(ws)).workspace!

    expect(built.members.find((m) => m.branchName === empty.branch)!.status).toBe('pending')
    expect(built.members.find((m) => m.branchName === real.branch)!.status).toBe('integrated')
    expect(benchMergeCount(built.benchPath)).toBe(1)
    expect(existsSync(join(built.benchPath, 'real.txt'))).toBe(true)
  })

  it('becomes integrated once it commits and the pin advances', async () => {
    // The full lifecycle: pending is not terminal. This is the path the operator
    // actually walks after enrolling a fresh worktree.
    const a = makeBareWorktree('a')
    const built = (await rebuildBench(workspaceFor([await enroll(a)]))).workspace!
    expect(built.members[0].status).toBe('pending')

    writeFileSync(join(a.path, 'a.txt'), 'a work\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a: first real commit')

    // Re-pin exactly as the Update verb does, then rebuild.
    const rebuilt = (await rebuildBench({
      ...built,
      members: [await enroll(a)],
    })).workspace!

    const member = rebuilt.members.find((m) => m.branchName === a.branch)!
    expect(member.status).toBe('integrated')
    expect(member.pinnedBaseSha).not.toBe(member.pinnedSha)
    expect(benchMergeCount(rebuilt.benchPath)).toBe(1)
    expect(existsSync(join(rebuilt.benchPath, 'a.txt'))).toBe(true)
  })

  it('still retires a member whose real work landed', async () => {
    // The behaviour that must NOT regress: absorption is still absorption when
    // the pin actually carried commits.
    const a = makeWorktree('a')
    const built = (await rebuildBench(workspaceFor([await enroll(a)]))).workspace!
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })

    const result = await rebuildBench(built)

    expect(result.workspace!.members.map((m) => m.branchName)).not.toContain(a.branch)
    expect((result.retired ?? []).map((m) => m.branchName)).toContain(a.branch)
  })
}, GIT_FIXTURE_TIMEOUT)

describe('rebuildBench — records written before the contribution range existed', () => {
  it('backfills a legacy member that carries commits and merges it', async () => {
    const a = makeWorktree('a')
    const legacy = { ...(await enroll(a)), pinnedBaseSha: '' }
    const ws = workspaceFor([legacy])

    const built = (await rebuildBench(ws)).workspace!
    const member = built.members.find((m) => m.branchName === a.branch)!

    // Unchanged behaviour for the common case, and the range is now recorded.
    expect(member.status).toBe('integrated')
    expect(member.pinnedBaseSha).not.toBe('')
    expect(member.pinnedBaseSha).not.toBe(member.pinnedSha)
    expect(benchMergeCount(built.benchPath)).toBe(1)
  })

  it('reads a legacy member with no commits as pending, not landed', async () => {
    // This is the state the operator's bench file was actually in.
    const a = makeBareWorktree('a')
    const legacy = { ...(await enroll(a)), pinnedBaseSha: '' }

    const result = await rebuildBench(workspaceFor([legacy]))
    const member = result.workspace!.members.find((m) => m.branchName === a.branch)

    expect(member).toBeDefined()
    expect(member!.status).toBe('pending')
    expect(member!.pinnedBaseSha).toBe(member!.pinnedSha)
    expect((result.retired ?? [])).toHaveLength(0)
  })

  it('still retires a legacy member whose branch is gone after landing', async () => {
    // An unresolvable range must fall through to the landed tiers rather than
    // parking the member as pending forever.
    const a = makeWorktree('a')
    const built = (await rebuildBench(workspaceFor([await enroll(a)]))).workspace!
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    const legacy = built.members.map((m) => ({ ...m, pinnedBaseSha: '' }))
    const result = await rebuildBench({ ...built, members: legacy })

    expect(result.workspace!.members.map((m) => m.branchName)).not.toContain(a.branch)
    expect((result.retired ?? []).map((m) => m.branchName)).toContain(a.branch)
  })
}, GIT_FIXTURE_TIMEOUT)
