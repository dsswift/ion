/**
 * The operator's full parallel-development scenario, end to end.
 *
 * This test is the narrative walkthrough, asserted beat by beat:
 *
 *   1. Start on `main`; branch `josh` from it (same head).
 *   2. Cut two worktrees off `josh` and work in both.
 *   3. Both are members of the bench, which points at `josh`.
 *   4. Rack up many commits in each.
 *   5. Worktree 1 is done; worktree 2 still needs tightening.
 *   6. Squash worktree 1 down to a tight commit.
 *   7. Land worktree 1 -> `josh` gains ONE commit, not dozens.
 *   8. The bench clears itself, takes a fresh `josh`, and re-layers only the
 *      remaining worktree on top.
 *   9. `main` is exactly where it was when `josh` was cut.
 *  10. `josh` is one commit ahead of `main`.
 *  11. The bench base is `josh` (carrying worktree 1's landed work) plus
 *      worktree 2's changes layered as a merge.
 *
 * The repo root is checked out on `josh` here, matching the real setup: the
 * operator works on their feature branch in the main clone, so landing takes
 * the in-place merge path rather than the ref-advance path.
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
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_SCENARIO || actual.homedir() }
})

import { rebuildBench } from '../integration/bench-rebuild'
import { captureContribution } from '../integration/bench-snapshot'
import { makeWorkspace, makeMember } from '../integration/bench-store'
import { landWorktree } from '../worktree/integrate'
import { retireWorktree } from '../worktree/relocate'
import type { IntegrationWorkspace, IntegrationMember } from '../../shared/types'

const TRUNK = 'main'
const FEATURE = 'josh'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-scenario-')))
  process.env.ION_TEST_HOME_BENCH_SCENARIO = join(root, 'home')

  // ── Beat 1: start from main, branch to josh ───────────────────────────────
  repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', TRUNK, repo], { encoding: 'utf-8' })
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Dev')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'app.txt'), 'shipped code\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'trunk: shipped state')
  // josh is cut from main and is what the operator actually works on.
  git(repo, 'checkout', '-b', FEATURE)
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_SCENARIO
  rmSync(root, { recursive: true, force: true })
})

function makeWorktree(name: string): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)
  return { path, branch }
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

function workspaceFor(members: IntegrationMember[]): IntegrationWorkspace {
  const ws = makeWorkspace(repo, FEATURE)
  return { ...ws, benchPath: join(root, 'bench'), benchBranch: `ion/bench/${FEATURE}`, members }
}

/** Commits on `ref` that are not on `base`. */
function commitsAhead(cwd: string, base: string, ref: string): string[] {
  const out = git(cwd, 'log', '--format=%s', `${base}..${ref}`).trim()
  return out ? out.split('\n') : []
}

function benchMerges(benchPath: string): string[] {
  const out = git(benchPath, 'log', '--merges', '--format=%s', `${FEATURE}..HEAD`).trim()
  return out ? out.split('\n') : []
}

describe('operator scenario: two worktrees, squash one, land it, bench re-layers', () => {
  it('walks the full flow with every beat asserted', async () => {
    const trunkHeadAtBranchTime = git(repo, 'rev-parse', TRUNK).trim()
    // Beat 1 check: josh starts level with main.
    expect(git(repo, 'rev-parse', FEATURE).trim()).toBe(trunkHeadAtBranchTime)

    // ── Beat 2: two worktrees off josh ──────────────────────────────────────
    const wt1 = makeWorktree('wt1')
    const wt2 = makeWorktree('wt2')

    // ── Beat 4: dozens of commits in each ───────────────────────────────────
    for (let n = 1; n <= 12; n++) {
      writeFileSync(join(wt1.path, 'feature-one.txt'), `feature one, iteration ${n}\n`)
      git(wt1.path, 'add', '-A')
      git(wt1.path, 'commit', '-m', `wt1 wip ${n}`)
    }
    for (let n = 1; n <= 9; n++) {
      writeFileSync(join(wt2.path, 'feature-two.txt'), `feature two, iteration ${n}\n`)
      git(wt2.path, 'add', '-A')
      git(wt2.path, 'commit', '-m', `wt2 wip ${n}`)
    }
    expect(commitsAhead(wt1.path, FEATURE, 'HEAD')).toHaveLength(12)
    expect(commitsAhead(wt2.path, FEATURE, 'HEAD')).toHaveLength(9)

    // ── Beat 3: both are bench members; the bench points at josh ────────────
    const ws = workspaceFor([await enroll(wt1), await enroll(wt2)])
    const built = (await rebuildBench(ws)).workspace!
    expect(built.sourceBranch).toBe(FEATURE)
    // Both features present, one merge commit each.
    expect(existsSync(join(ws.benchPath, 'feature-one.txt'))).toBe(true)
    expect(existsSync(join(ws.benchPath, 'feature-two.txt'))).toBe(true)
    expect(benchMerges(ws.benchPath)).toHaveLength(2)

    // ── Beats 5-6: wt1 is done and gets squashed; wt2 keeps going ───────────
    git(wt1.path, 'reset', '--soft', FEATURE)
    git(wt1.path, 'commit', '-m', 'feat: feature one, complete')
    expect(commitsAhead(wt1.path, FEATURE, 'HEAD')).toEqual(['feat: feature one, complete'])

    // wt2 is still being tightened after the bench was last built.
    writeFileSync(join(wt2.path, 'feature-two.txt'), 'feature two, still tightening\n')
    git(wt2.path, 'add', '-A')
    git(wt2.path, 'commit', '-m', 'wt2 wip 10')

    // ── Beat 7: land wt1 into josh — one commit, not a dozen ────────────────
    const landed = await landWorktree({
      repoPath: repo, worktreePath: wt1.path, worktreeBranch: wt1.branch, sourceBranch: FEATURE,
    })
    expect(landed.ok).toBe(true)

    const joshAhead = commitsAhead(repo, TRUNK, FEATURE)
    // The squashed commit, plus the merge commit the in-place land creates.
    expect(joshAhead).toContain('feat: feature one, complete')
    expect(joshAhead.some((s) => s.startsWith('wt1 wip'))).toBe(false)
    // Nowhere near the dozen wip commits.
    expect(joshAhead.length).toBeLessThanOrEqual(2)

    // Retire the finished worktree (the "Land & retire" verb).
    const retiredWt = await retireWorktree({ repoPath: repo, worktreePath: wt1.path, branchName: wt1.branch })
    expect(retiredWt.ok).toBe(true)
    expect(retiredWt.workingDirectory).toBe(repo)

    // ── Beat 8: the bench clears, takes a fresh josh, re-layers only wt2 ────
    // wt2's pin is advanced first (an explicit Update for its new commit).
    const wt2Advanced = await enroll(wt2)
    const beforeRebuild = {
      ...built,
      members: built.members.map((m) => (m.branchName === wt2.branch ? { ...m, ...wt2Advanced } : m)),
    }
    const result = await rebuildBench(beforeRebuild)
    expect(result.ok).toBe(true)

    // wt1 was absorbed into the base and retired from the member list …
    expect(result.retired!.map((m) => m.branchName)).toEqual([wt1.branch])
    expect(result.retired![0].status).toBe('landed')
    // … leaving exactly one member to layer.
    expect(result.workspace!.members.map((m) => m.branchName)).toEqual([wt2.branch])

    // ── Beat 11: base is josh (carrying wt1) + wt2 layered as one merge ─────
    expect(result.workspace!.baseSha).toBe(git(repo, 'rev-parse', FEATURE).trim())
    expect(benchMerges(ws.benchPath)).toHaveLength(1)
    // wt1's work is present, sourced from the BASE (no merge of its own).
    expect(readFileSync(join(ws.benchPath, 'feature-one.txt'), 'utf-8')).toBe('feature one, iteration 12\n')
    // wt2's newest work is present, layered from its worktree.
    expect(readFileSync(join(ws.benchPath, 'feature-two.txt'), 'utf-8')).toBe('feature two, still tightening\n')

    // ── Beats 9-10: main untouched; josh ahead of it ────────────────────────
    expect(git(repo, 'rev-parse', TRUNK).trim()).toBe(trunkHeadAtBranchTime)
    expect(commitsAhead(repo, TRUNK, FEATURE).length).toBeGreaterThan(0)
    // main never received the feature work — that happens later via a PR.
    expect(git(repo, 'ls-tree', '--name-only', TRUNK)).not.toContain('feature-one.txt')

    // wt2's worktree is still fully usable for continued iteration.
    expect(existsSync(wt2.path)).toBe(true)
    expect(git(wt2.path, 'status', '--porcelain')).toBe('')
  })

  it('continues to iterate wt2 and land it, ending with josh holding both features', async () => {
    const wt1 = makeWorktree('wt1')
    const wt2 = makeWorktree('wt2')
    writeFileSync(join(wt1.path, 'feature-one.txt'), 'one\n')
    git(wt1.path, 'add', '-A')
    git(wt1.path, 'commit', '-m', 'wt1 work')
    writeFileSync(join(wt2.path, 'feature-two.txt'), 'two\n')
    git(wt2.path, 'add', '-A')
    git(wt2.path, 'commit', '-m', 'wt2 work')

    const ws = workspaceFor([await enroll(wt1), await enroll(wt2)])
    let state = (await rebuildBench(ws)).workspace!

    // Land wt1, rebuild: absorbed.
    await landWorktree({ repoPath: repo, worktreePath: wt1.path, worktreeBranch: wt1.branch, sourceBranch: FEATURE })
    state = (await rebuildBench(state)).workspace!
    expect(state.members.map((m) => m.branchName)).toEqual([wt2.branch])

    // Keep iterating wt2, then squash and land it too.
    writeFileSync(join(wt2.path, 'feature-two.txt'), 'two, finished\n')
    git(wt2.path, 'add', '-A')
    git(wt2.path, 'commit', '-m', 'wt2 more work')
    // Sync onto the moved feature branch BEFORE squashing. Squashing against a
    // stale base (`reset --soft josh` when josh has advanced) would author a
    // commit that reverts the work landed in between — this is the real
    // workflow order, and asserting it here documents why.
    git(wt2.path, 'rebase', FEATURE)
    git(wt2.path, 'reset', '--soft', FEATURE)
    git(wt2.path, 'commit', '-m', 'feat: feature two, complete')
    await landWorktree({ repoPath: repo, worktreePath: wt2.path, worktreeBranch: wt2.branch, sourceBranch: FEATURE })

    const final = await rebuildBench(state)

    // Both features are now in josh; the bench has no members left and its
    // content equals the feature branch.
    expect(final.retired!.map((m) => m.branchName)).toEqual([wt2.branch])
    expect(final.workspace!.members).toHaveLength(0)
    expect(benchMerges(ws.benchPath)).toHaveLength(0)
    expect(readFileSync(join(ws.benchPath, 'feature-one.txt'), 'utf-8')).toBe('one\n')
    expect(readFileSync(join(ws.benchPath, 'feature-two.txt'), 'utf-8')).toBe('two, finished\n')
    // The bench tree is now identical to josh — nothing pending to layer.
    expect(git(ws.benchPath, 'rev-parse', 'HEAD^{tree}').trim())
      .toBe(git(repo, 'rev-parse', `${FEATURE}^{tree}`).trim())
    // main is still untouched, ready for a PR from josh.
    expect(git(repo, 'ls-tree', '--name-only', TRUNK)).not.toContain('feature-two.txt')
  })

  // A land while the operator is mid-build in the feature checkout must not
  // yank their working tree out from under them.
  it('refuses to land into josh while the feature checkout is dirty', async () => {
    const wt1 = makeWorktree('wt1')
    writeFileSync(join(wt1.path, 'feature-one.txt'), 'one\n')
    git(wt1.path, 'add', '-A')
    git(wt1.path, 'commit', '-m', 'wt1 work')

    // The operator is editing in the josh checkout.
    writeFileSync(join(repo, 'app.txt'), 'local edits in flight\n')

    const result = await landWorktree({
      repoPath: repo, worktreePath: wt1.path, worktreeBranch: wt1.branch, sourceBranch: FEATURE,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/uncommitted changes/i)
    // Their edit survives and josh did not move.
    expect(readFileSync(join(repo, 'app.txt'), 'utf-8')).toBe('local edits in flight\n')
    expect(commitsAhead(repo, TRUNK, FEATURE)).toHaveLength(0)
  })
})
