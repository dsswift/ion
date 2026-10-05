/**
 * A removal git started and could not finish.
 *
 * `git worktree remove` unregisters the worktree, then deletes the directory.
 * When a provisioning run was still writing into it, the delete failed part
 * way: git no longer listed the path, files were left behind, and every retry
 * failed with "is not a working tree". Inside an enclosing repository (an
 * operator's ~/.ion can be one), git run in the leftover directory answered
 * for that repository instead, so the appraisal read the wrong one.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { appraiseWorktree } from '../safety'
import { discardWorktree } from '../relocate'
import { registerWorktree } from '../registry'
import { lookupWorktreeRegistration } from '../registry-helpers'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf-8' })
  git(dir, 'config', 'user.email', 'dev@example.com')
  git(dir, 'config', 'user.name', 'Dev')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

let root: string
let repo: string
let worktree: string
const branch = 'wt/half'

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ion-interrupted-')))
  // The worktree lives inside an unrelated repository, as ~/.ion/worktrees can.
  initRepo(root)
  repo = join(root, 'repo')
  mkdirSync(repo)
  initRepo(repo)
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-qb', 'parking')
  worktree = join(root, 'worktrees', 'half')
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'main')
  registerWorktree({ worktreePath: worktree, repoPath: repo, branchName: branch, sourceBranch: 'main' })
})

afterEach(() => {
  removeGitFixture(root)
})

/** What a delete that failed part way leaves: git's record gone, some files still there. */
function interruptRemoval(): void {
  rmSync(join(repo, '.git', 'worktrees', 'half'), { recursive: true, force: true })
  rmSync(join(worktree, '.git'), { force: true })
  rmSync(join(worktree, 'base.txt'), { force: true })
  mkdirSync(join(worktree, 'graphify-out'))
  writeFileSync(join(worktree, 'graphify-out', 'graph.json'), '{}')
}

describe('a worktree whose removal was interrupted', () => {
  it('is appraised from its branch, never from the enclosing repository', async () => {
    interruptRemoval()
    // The enclosing repository has untracked files; reading it would say "unsafe".
    writeFileSync(join(root, 'stray.txt'), 'x')

    const appraisal = await appraiseWorktree(worktree, 'main')

    expect(appraisal.checkoutRemoved).toBe(true)
    expect(appraisal.safeToDiscard).toBe(true)
    expect(appraisal.uncommittedPaths).toEqual([])
  })

  it('is discarded completely on retry: directory, branch, and record', async () => {
    interruptRemoval()

    const result = await discardWorktree({ repoPath: repo, worktreePath: worktree, branchName: branch, sourceBranch: 'main' })

    expect(result.ok).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(git(repo, 'branch', '--list', branch).trim()).toBe('')
    expect(lookupWorktreeRegistration(worktree)).toBeNull()
  })

  it('keeps unlanded commits: refuses when asked to, otherwise anchors them first', async () => {
    writeFileSync(join(worktree, 'feature.txt'), 'work\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-qm', 'unlanded work')
    const tip = git(worktree, 'rev-parse', 'HEAD').trim()
    interruptRemoval()

    const refused = await discardWorktree({ repoPath: repo, worktreePath: worktree, branchName: branch, sourceBranch: 'main', onlyIfSafe: true })
    expect(refused.ok).toBe(false)
    expect(refused.refusedUnlanded).toBe(true)
    expect(existsSync(worktree)).toBe(true)

    const discarded = await discardWorktree({ repoPath: repo, worktreePath: worktree, branchName: branch, sourceBranch: 'main' })
    expect(discarded.ok).toBe(true)
    expect(discarded.recoveryRef).toBeTruthy()
    expect(git(repo, 'rev-parse', discarded.recoveryRef!).trim()).toBe(tip)
  })

  it('refuses a directory that holds a repository of its own', async () => {
    rmSync(join(repo, '.git', 'worktrees', 'half'), { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
    initRepo(worktree)

    const result = await discardWorktree({ repoPath: repo, worktreePath: worktree, branchName: branch, sourceBranch: 'main' })

    expect(result.ok).toBe(false)
    expect(existsSync(join(worktree, '.git'))).toBe(true)
  })
})
