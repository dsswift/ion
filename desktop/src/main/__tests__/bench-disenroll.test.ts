/**
 * Auto-disenrollment and empty-bench pruning.
 *
 * The asymmetry under test: **enrollment is manual, disenrollment is automatic.**
 * Enrolling is a judgement ("integrate this work"), so it stays an explicit act.
 * Disenrolling a worktree that no longer exists is bookkeeping catching up with
 * reality -- a member whose worktree is gone can never be updated, rebuilt from,
 * or landed, so leaving it produces a permanent `missing` row the operator can
 * only clear by hand.
 *
 * The hook is RETIRE, not tab close: closing a conversation deliberately leaves
 * the worktree (and its membership) intact so the operator can come back to it.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  // Per-file env var: vitest runs test FILES concurrently in one process, so a
  // shared name would let files clobber each other's fake home -- passing in
  // isolation and failing in the suite.
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_DISENROLL || actual.homedir() }
})

import {
  ensureWorkspace, addMember, disenrollWorktree, listWorkspaces, assembleWorkspace,
  predictPrunedBenches,
} from '../integration/bench-ops'
import { loadWorkspaces, saveWorkspaces } from '../integration/bench-store'
import { retireWorktree } from '../worktree/relocate'
import { landWorktree } from '../worktree/integrate'
import { GIT_FIXTURE_TIMEOUT } from '../../test/git-fixture-timeout'

const FEATURE = 'josh'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-disenroll-')))
  process.env.ION_TEST_HOME_BENCH_DISENROLL = join(root, 'home')
  mkdirSync(join(root, 'home', '.ion'), { recursive: true })

  repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf-8' })
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Dev')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'base')
  git(repo, 'branch', FEATURE)
  git(repo, 'checkout', '-b', 'parking')
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_DISENROLL
  removeGitFixture(root)
})

function makeWorktree(name: string): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)
  writeFileSync(join(path, `${name}.txt`), `${name}\n`)
  git(path, 'add', '-A')
  git(path, 'commit', '-m', `${name} work`)
  return { path, branch }
}

/** Point the workspace's bench inside the test root instead of ~/.ion. */
function localBench(): void {
  const ws = ensureWorkspace(repo, FEATURE)
  const all = loadWorkspaces()
  const idx = all.findIndex((w) => w.repoPath === repo && w.sourceBranch === FEATURE)
  all[idx] = { ...ws, benchPath: join(root, 'bench'), benchBranch: `ion/bench/${FEATURE}` }
  saveWorkspaces(all)
}

describe('disenrollWorktree', () => {
  it('removes the worktree from a bench that has other members', async () => {
    localBench()
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, b.path, b.branch)

    const result = disenrollWorktree(a.path)

    expect(result.removedFrom).toBe(1)
    expect(result.prunedBenches).toHaveLength(0)
    const ws = listWorkspaces(repo)[0]
    expect(ws.members.map((m) => m.branchName)).toEqual([b.branch])
  })

  // An empty bench holds nothing unique -- its content is exactly the feature
  // branch -- so keeping it would accumulate one dead bench per feature branch
  // ever integrated into.
  it('prunes the bench when the last member is disenrolled', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)

    const result = disenrollWorktree(a.path)

    expect(result.removedFrom).toBe(1)
    expect(result.prunedBenches).toEqual([join(root, 'bench')])
    expect(listWorkspaces(repo)).toHaveLength(0)
  })

  it('is a no-op for a worktree that is not a member', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)

    const result = disenrollWorktree(join(root, 'never-enrolled'))

    expect(result.removedFrom).toBe(0)
    expect(listWorkspaces(repo)[0].members).toHaveLength(1)
  })

  it('removes the worktree from every bench that held it', async () => {
    // Two feature branches, each with its own bench, both holding the same
    // worktree (possible when a worktree is enrolled, the branch changes, and
    // it is enrolled again).
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    git(repo, 'branch', 'beta')
    const other = ensureWorkspace(repo, 'beta')
    const all = loadWorkspaces()
    const idx = all.findIndex((w) => w.sourceBranch === 'beta')
    all[idx] = { ...other, benchPath: join(root, 'bench-beta') }
    saveWorkspaces(all)
    await addMember(repo, 'beta', a.path, a.branch)
    expect(listWorkspaces(repo)).toHaveLength(2)

    const result = disenrollWorktree(a.path)

    expect(result.removedFrom).toBe(2)
    expect(listWorkspaces(repo)).toHaveLength(0)
  })
}, GIT_FIXTURE_TIMEOUT)

describe('retire disenrolls automatically', () => {
  it('drops the member and prunes the empty bench, removing its worktree', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await assembleWorkspace(repo, FEATURE)
    expect(existsSync(join(root, 'bench'))).toBe(true)

    // Land first so the retire is not refused for unlanded work.
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    expect(result.ok).toBe(true)
    // Membership is gone, the bench record is gone, and its directory with it.
    expect(listWorkspaces(repo)).toHaveLength(0)
    expect(existsSync(join(root, 'bench'))).toBe(false)
  })

  it('keeps the bench when another member remains', async () => {
    localBench()
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, b.path, b.branch)
    await assembleWorkspace(repo, FEATURE)

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    const ws = listWorkspaces(repo)[0]
    expect(ws.members.map((m) => m.branchName)).toEqual([b.branch])
    expect(existsSync(join(root, 'bench'))).toBe(true)
  })

  // A retire that is REFUSED must not disenroll: the worktree still exists, so
  // its membership is still valid.
  it('does not disenroll when the retire is refused', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    // Uncommitted work makes retire refuse by default.
    writeFileSync(join(a.path, 'wip.txt'), 'in progress\n')

    const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    expect(result.ok).toBe(false)
    expect(listWorkspaces(repo)[0].members).toHaveLength(1)
    expect(existsSync(a.path)).toBe(true)
  })

  it('disenrolls a member whose work never landed', async () => {
    localBench()
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, b.path, b.branch)

    // Force-retire without landing: the work is discarded deliberately, and the
    // membership must go with it rather than lingering as `missing` forever.
    await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch, force: true })

    expect(listWorkspaces(repo)[0].members.map((m) => m.branchName)).toEqual([b.branch])
  })
}, GIT_FIXTURE_TIMEOUT)

/**
 * The retire REPORTS which benches it removed, and the preview PREDICTS the same
 * set before anything is touched.
 *
 * ── Why both halves matter ──────────────────────────────────────────────────
 * A bench directory hosts real conversations and a dedicated terminal. Retiring
 * the last member of a bench deletes that directory, so a caller that closes the
 * retired worktree's tabs but not the bench's would leave them pointed at a path
 * that no longer exists — and a caller that cannot ask the question BEFORE the
 * retire cannot refuse when one of those bench conversations is still running.
 *
 * The prediction and the mutation share `wouldPruneBench`, so the agreement
 * asserted here is structural rather than coincidental. Regression direction:
 * give `predictPrunedBenches` its own emptiness rule and the agreement tests go
 * red as soon as the two definitions differ.
 */
describe('retire reports and predicts the benches it prunes', () => {
  it('returns the pruned bench path from the retire', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await assembleWorkspace(repo, FEATURE)

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    expect(result.ok).toBe(true)
    expect(result.prunedBenchPaths).toEqual([join(root, 'bench')])
  })

  it('predicts that same path BEFORE the retire runs, without mutating anything', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)

    const predicted = predictPrunedBenches(a.path)

    expect(predicted).toEqual([join(root, 'bench')])
    // Read-only: the membership is untouched, so a preview can be called from a
    // menu handler as often as it likes.
    expect(listWorkspaces(repo)[0].members).toHaveLength(1)
  })

  it('predicts nothing for a bench that keeps another member', async () => {
    localBench()
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, b.path, b.branch)

    expect(predictPrunedBenches(a.path)).toEqual([])

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    // And the retire agrees: the bench survives, so nothing was removed.
    expect(result.prunedBenchPaths).toEqual([])
  })

  it('predicts nothing for a worktree in no bench, and the retire reports none', async () => {
    const a = makeWorktree('a')

    expect(predictPrunedBenches(a.path)).toEqual([])

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: FEATURE })
    const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    expect(result.ok).toBe(true)
    expect(result.prunedBenchPaths).toEqual([])
  })

  it('predicts every bench that holds the worktree alone', async () => {
    // Two feature branches, each with a bench whose only member is this
    // worktree: retiring it empties both.
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)

    const other = ensureWorkspace(repo, 'beta')
    const all = loadWorkspaces()
    const idx = all.findIndex((w) => w.repoPath === repo && w.sourceBranch === 'beta')
    all[idx] = { ...other, benchPath: join(root, 'bench-beta') }
    saveWorkspaces(all)
    await addMember(repo, 'beta', a.path, a.branch)

    expect(predictPrunedBenches(a.path).sort()).toEqual(
      [join(root, 'bench'), join(root, 'bench-beta')].sort(),
    )
  })
}, GIT_FIXTURE_TIMEOUT)
