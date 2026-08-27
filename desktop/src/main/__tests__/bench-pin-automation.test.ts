/**
 * Pin-advance automation tests. These use a dedicated fixture so automation
 * behavior stays separate from core bench lifecycle coverage.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

let storeDir: string
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_AUTOMATION || actual.homedir() }
})

import { addMember, updateMember, updateAllStale, ensureWorkspace } from '../integration/bench-ops'
import { loadWorkspaces, saveWorkspaces } from '../integration/bench-store'
import { setWorktreeStage, lookupWorktreeStage } from '../worktree/inventory'
import { setWorktreePinAdvanceAutomationTrigger } from '../worktree/pin-advance-trigger'

const FEATURE = 'josh'
let root: string
let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-bench-automation-')))
  storeDir = join(root, 'home')
  execFileSync('mkdir', ['-p', join(storeDir, '.ion')])
  process.env.ION_TEST_HOME_BENCH_AUTOMATION = storeDir
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
  setWorktreePinAdvanceAutomationTrigger(null)
  delete process.env.ION_TEST_HOME_BENCH_AUTOMATION
  removeGitFixture(root)
})

function makeWorktree(name: string): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)
  writeFileSync(join(path, `${name}.txt`), `${name} v1\n`)
  git(path, 'add', '-A')
  git(path, 'commit', '-m', `${name} work`)
  return { path, branch }
}

function commitIn(dir: string, file: string, content: string, msg: string): void {
  writeFileSync(join(dir, file), content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', msg)
}

function localBench(sourceBranch = FEATURE): void {
  const ws = ensureWorkspace(repo, sourceBranch)
  const all = loadWorkspaces()
  const idx = all.findIndex((w) => w.repoPath === repo && w.sourceBranch === sourceBranch)
  all[idx] = { ...ws, benchPath: join(root, 'bench'), benchBranch: `ion/bench/${sourceBranch}` }
  saveWorkspaces(all)
}

describe('worktree pin-advance automation', () => {
  it('a bug stage survives an Update that re-pins identical content', async () => {
    localBench()
    const a = makeWorktree('a')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    await addMember(repo, FEATURE, a.path, a.branch)
    setWorktreeStage(a.path, 'bug')

    // Nothing new committed: the pin cannot move, so the flag still applies
    // to exactly the content that was tested — the bug is still in there.
    await updateMember(repo, FEATURE, a.path)

    expect(lookupWorktreeStage(a.path)).toBe('bug')
  })

  it('uses legacy migration for bug stage when automation runtime is unavailable', async () => {
    localBench()
    const a = makeWorktree('a')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    await addMember(repo, FEATURE, a.path, a.branch)
    setWorktreeStage(a.path, 'bug')

    commitIn(a.path, 'a.txt', 'a v2\n', 'a fix')
    await updateMember(repo, FEATURE, a.path)

    // "There is an issue to fix" becomes "the fix is in, retest it" at the
    // moment new content reaches the bench.
    expect(lookupWorktreeStage(a.path)).toBe('test')
  })

  it('delivers pin-advance facts to automation without changing a stage', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    setWorktreeStage(a.path, 'bug')
    const seen: Array<{
      worktreePath: string
      branchName: string
      previousPinnedSha: string
      pinnedSha: string
    }> = []
    setWorktreePinAdvanceAutomationTrigger({
      onWorktreePinAdvance: (advance) => {
        seen.push(advance)
      },
    })

    commitIn(a.path, 'a.txt', 'a v2\n', 'a fix')
    await updateMember(repo, FEATURE, a.path)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      worktreePath: a.path,
      branchName: a.branch,
    })
    expect(seen[0].previousPinnedSha).not.toBe(seen[0].pinnedSha)
    expect(lookupWorktreeStage(a.path)).toBe('bug')
  })

  it('keeps a verified stage during legacy migration', async () => {
    localBench()
    const a = makeWorktree('a')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    await addMember(repo, FEATURE, a.path, a.branch)
    setWorktreeStage(a.path, 'verified')

    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')
    await updateMember(repo, FEATURE, a.path)

    // `verified` is a statement about the feature, not the pin. Only the
    // operator moves it.
    expect(lookupWorktreeStage(a.path)).toBe('verified')
  })

  it('uses legacy migration only for moved bug stages', async () => {
    localBench()
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const c = makeWorktree('c')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    commitIn(b.path, 'b.txt', 'b\n', 'b work')
    commitIn(c.path, 'c.txt', 'c\n', 'c work')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, b.path, b.branch)
    await addMember(repo, FEATURE, c.path, c.branch)
    setWorktreeStage(a.path, 'bug')
    setWorktreeStage(b.path, 'bug')
    setWorktreeStage(c.path, 'verified')

    // `a` and `c` move; `b` stays where it was tested.
    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')
    commitIn(c.path, 'c.txt', 'c v2\n', 'c more')
    await updateAllStale(repo, FEATURE)

    expect(lookupWorktreeStage(a.path)).toBe('test')
    expect(lookupWorktreeStage(b.path)).toBe('bug')
    expect(lookupWorktreeStage(c.path)).toBe('verified')
  })

  it('emits one automation fact for every changed update-all pin', async () => {
    localBench()
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, b.path, b.branch)
    const seen: string[] = []
    setWorktreePinAdvanceAutomationTrigger({
      onWorktreePinAdvance: (advance) => {
        seen.push(advance.worktreePath)
      },
    })

    commitIn(a.path, 'a.txt', 'a v2\n', 'a fix')
    commitIn(b.path, 'b.txt', 'b v2\n', 'b fix')
    await updateAllStale(repo, FEATURE)

    expect(seen).toEqual([a.path, b.path])
  })

  it('an unregistered or unstaged worktree is a no-op on pin advance', async () => {
    localBench()
    const a = makeWorktree('a')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    await addMember(repo, FEATURE, a.path, a.branch)
    // No stage set: the advance must not invent one.
    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')
    await updateMember(repo, FEATURE, a.path)

    expect(lookupWorktreeStage(a.path)).toBeNull()
  })
})
