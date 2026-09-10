import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { classifyMergeFailure, ensureBenchWorktree } from '../integration/bench-assemble-support'
import type { IntegrationWorkspace } from '../../shared/types'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

describe('classifyMergeFailure', () => {
  // The regression this pins: BEFORE the fix, a zero-paths failure produced
  // the bare fallback `"<branch> could not be merged. The bench is empty
  // until this is resolved."` — discarding the actual git error entirely.
  // This test fails if the message reverts to that bare fallback.
  it('classifies a zero-unmerged-paths failure as obstructed and surfaces the real git error verbatim', () => {
    const gitError = 'error: The following untracked working tree files would be overwritten by merge:\n'
      + '\tdesktop/src/main/worktree/sync.ts\n'
      + 'Please move or remove them before you merge.\n'
      + 'Aborting\n'
      + 'Merge with strategy ort failed.'

    const result = classifyMergeFailure('wt/ion-351c7dd4', [], [], gitError)

    expect(result.failureKind).toBe('obstructed')
    expect(result.failureError).toContain('wt/ion-351c7dd4')
    expect(result.failureError).toContain('would be overwritten by merge')
    expect(result.failureError).toContain('desktop/src/main/worktree/sync.ts')
    // Never the bare, detail-free fallback this replaced.
    expect(result.failureError).not.toBe(
      'wt/ion-351c7dd4 could not be merged. The bench is empty until this is resolved.',
    )
  })

  // The structural signal: at least one unmerged path is what makes it a
  // genuine content conflict, never a guess based on matching error text.
  it('classifies a merge failure with at least one unmerged path as a conflict', () => {
    const result = classifyMergeFailure('wt/a', ['shared.txt'], ['wt/b'], 'CONFLICT (content): Merge conflict in shared.txt')

    expect(result.failureKind).toBe('conflict')
    expect(result.failureError).toContain('wt/a')
    expect(result.failureError).toContain('conflicts on 1 file')
    expect(result.failureError).toContain('wt/b')
  })

  it('pluralizes the file count correctly', () => {
    const result = classifyMergeFailure('wt/a', ['a.txt', 'b.txt'], [], 'error')
    expect(result.failureError).toContain('conflicts on 2 files')
  })

  it('omits the "with <branches>" clause when nothing collided', () => {
    const result = classifyMergeFailure('wt/a', ['a.txt'], [], 'error')
    expect(result.failureError).not.toContain(' with ')
  })
})

describe('ensureBenchWorktree', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  // The regression this pins: a bench directory that exists on disk but has
  // NO git worktree registration (e.g. its `.git/worktrees/<name>` entry was
  // removed independently of the directory — the mirror image of the
  // already-handled "registered but missing on disk" case) used to fall
  // straight through to `git worktree add`, which refuses to target a
  // non-empty directory and fails with "already exists". Every subsequent
  // assembly hit the identical failure, wedging the bench permanently.
  it('clears an unregistered, non-empty bench directory before recreating it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ion-bench-worktree-'))
    roots.push(root)

    const repoPath = join(root, 'repo')
    mkdirSync(repoPath, { recursive: true })
    git(repoPath, 'init', '-b', 'main')
    git(repoPath, 'config', 'user.email', 'dev@example.com')
    git(repoPath, 'config', 'user.name', 'Dev')
    git(repoPath, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repoPath, 'app.txt'), 'hello\n')
    git(repoPath, 'add', '-A')
    git(repoPath, 'commit', '-m', 'initial')

    // Simulate the wedge: a bench directory that exists (with a stray
    // non-git file, as a Finder-dropped .DS_Store would leave behind) but is
    // registered with git nowhere.
    const benchPath = join(root, 'integration', 'ion-main')
    mkdirSync(benchPath, { recursive: true })
    writeFileSync(join(benchPath, '.DS_Store'), '')
    expect(git(repoPath, 'worktree', 'list', '--porcelain')).not.toContain(benchPath)

    const ws = {
      repoPath,
      sourceBranch: 'main',
      benchPath,
      benchBranch: 'ion/bench/main',
      members: [],
      baseSha: '',
      lastBuiltAt: 0,
    } as unknown as IntegrationWorkspace

    await ensureBenchWorktree(ws)

    const listed = git(repoPath, 'worktree', 'list', '--porcelain')
    expect(listed).toContain(benchPath)
  })
})
