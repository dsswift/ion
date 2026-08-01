/**
 * Worktree DATA SAFETY — the suite that guarantees work is never lost.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 * `closeTab` called `gitWorktreeRemove(..., force=true)` unconditionally, and
 * the remove handler followed it with `git branch -D`. That pair is
 * unrecoverable: `--force` discards uncommitted changes with the directory, and
 * `-D` makes committed-but-unlanded commits unreachable. Closing a worktree tab
 * therefore destroyed real work with no prompt and no way back.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * 1. The appraisal tells the truth about what would be lost, for every shape of
 *    at-risk work (untracked, tracked-modified, staged, unlanded commits).
 * 2. The appraisal FAILS CLOSED: an unreadable worktree or a missing source
 *    branch is never reported as "safe to discard".
 * 3. When the operator does discard, the work is still recoverable from a real
 *    ref, and the recovered content is byte-identical.
 * 4. Preservation does not disturb the worktree it is rescuing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { appraiseWorktree, preserveWorktreeWork, listPreservedWork } from '../worktree/safety'
import { landWorktree } from '../worktree/integrate'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

function makeRepo(): string {
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf-8' })
  git(dir, 'config', 'user.email', 'dev@example.com')
  git(dir, 'config', 'user.name', 'Dev')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  writeFileSync(join(dir, 'tracked.txt'), 'original\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  git(dir, 'checkout', '-b', 'parking')
  return dir
}

function makeWorktree(name: string): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, 'main')
  return { path, branch }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-safety-')))
  repo = makeRepo()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('appraiseWorktree — tells the truth about what would be lost', () => {
  it('reports a pristine worktree as safe to discard', async () => {
    const a = makeWorktree('a')

    const appraisal = await appraiseWorktree(a.path, 'main')

    expect(appraisal.safeToDiscard).toBe(true)
    expect(appraisal.hasUncommittedChanges).toBe(false)
    expect(appraisal.unlandedCommitCount).toBe(0)
    expect(appraisal.fullyLanded).toBe(true)
  })

  it('detects an untracked file', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'new-work.txt'), 'never saved\n')

    const appraisal = await appraiseWorktree(a.path, 'main')

    expect(appraisal.safeToDiscard).toBe(false)
    expect(appraisal.hasUncommittedChanges).toBe(true)
    expect(appraisal.uncommittedPaths).toContain('new-work.txt')
    expect(appraisal.reason).toMatch(/uncommitted/i)
  })

  // Distinct from untracked: several git plumbing commands ignore untracked
  // files, so an implementation can easily miss one shape while catching the
  // other.
  it('detects a modification to a tracked file', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'tracked.txt'), 'MODIFIED\n')

    const appraisal = await appraiseWorktree(a.path, 'main')

    expect(appraisal.safeToDiscard).toBe(false)
    expect(appraisal.hasUncommittedChanges).toBe(true)
    expect(appraisal.uncommittedPaths).toContain('tracked.txt')
  })

  it('detects staged-but-uncommitted changes', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'staged.txt'), 'staged only\n')
    git(a.path, 'add', 'staged.txt')

    const appraisal = await appraiseWorktree(a.path, 'main')

    expect(appraisal.safeToDiscard).toBe(false)
    expect(appraisal.hasUncommittedChanges).toBe(true)
    expect(appraisal.uncommittedPaths).toContain('staged.txt')
  })

  // The most dangerous case: everything is committed, so a naive "is it dirty"
  // check says clean — but the commits have not landed, and `branch -D` would
  // make them unreachable.
  it('detects committed-but-unlanded commits on an otherwise clean worktree', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'feature.txt'), 'real work\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'implement the feature')

    const appraisal = await appraiseWorktree(a.path, 'main')

    expect(appraisal.hasUncommittedChanges).toBe(false)
    expect(appraisal.safeToDiscard).toBe(false)
    expect(appraisal.unlandedCommitCount).toBe(1)
    expect(appraisal.fullyLanded).toBe(false)
    expect(appraisal.reason).toMatch(/not yet landed in main/i)
  })

  it('counts every unlanded commit', async () => {
    const a = makeWorktree('a')
    for (const n of [1, 2, 3]) {
      writeFileSync(join(a.path, `c${n}.txt`), `${n}\n`)
      git(a.path, 'add', '-A')
      git(a.path, 'commit', '-m', `commit ${n}`)
    }

    const appraisal = await appraiseWorktree(a.path, 'main')

    expect(appraisal.unlandedCommitCount).toBe(3)
    expect(appraisal.safeToDiscard).toBe(false)
  })

  it('reports safe again once the work has landed', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'feature.txt'), 'real work\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'implement the feature')
    expect((await appraiseWorktree(a.path, 'main')).safeToDiscard).toBe(false)

    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })

    const appraisal = await appraiseWorktree(a.path, 'main')
    expect(appraisal.safeToDiscard).toBe(true)
    expect(appraisal.fullyLanded).toBe(true)
  })

  it('reports both problems together', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'committed.txt'), 'committed\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'some work')
    writeFileSync(join(a.path, 'dirty.txt'), 'uncommitted too\n')

    const appraisal = await appraiseWorktree(a.path, 'main')

    expect(appraisal.hasUncommittedChanges).toBe(true)
    expect(appraisal.unlandedCommitCount).toBe(1)
    expect(appraisal.reason).toMatch(/uncommitted/i)
    expect(appraisal.reason).toMatch(/landed/i)
  })
})

describe('appraiseWorktree — fails closed', () => {
  // "I could not tell" must never render as "safe to delete".
  it('refuses to declare a nonexistent worktree safe', async () => {
    const appraisal = await appraiseWorktree(join(root, 'does-not-exist'), 'main')

    expect(appraisal.safeToDiscard).toBe(false)
    expect(appraisal.appraisalFailed).toBe(true)
    expect(appraisal.reason).toMatch(/could not determine/i)
  })

  it('refuses when the source branch does not exist', async () => {
    const a = makeWorktree('a')

    const appraisal = await appraiseWorktree(a.path, 'no-such-branch')

    expect(appraisal.safeToDiscard).toBe(false)
    expect(appraisal.appraisalFailed).toBe(true)
  })

  it('refuses for a directory that is not a git worktree', async () => {
    const plain = join(root, 'plain')
    execFileSync('mkdir', ['-p', plain])

    const appraisal = await appraiseWorktree(plain, 'main')

    expect(appraisal.safeToDiscard).toBe(false)
    expect(appraisal.appraisalFailed).toBe(true)
  })
})

describe('preserveWorktreeWork — discarded work stays recoverable', () => {
  it('preserves unlanded commits so a branch delete cannot lose them', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'feature.txt'), 'important work\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'important work')
    const lostSha = git(a.path, 'rev-parse', 'HEAD').trim()

    const preserved = await preserveWorktreeWork(repo, a.path, a.branch)
    expect(preserved.error).toBeUndefined()
    expect(preserved.refs.length).toBeGreaterThan(0)

    // Now do the destructive thing the old code did.
    git(repo, 'worktree', 'remove', '--force', a.path)
    git(repo, 'branch', '-D', a.branch)
    git(repo, 'reflog', 'expire', '--expire=now', '--all')
    git(repo, 'gc', '--prune=now', '--quiet')

    // The commit survived gc, and its content is intact.
    expect(git(repo, 'cat-file', '-t', lostSha).trim()).toBe('commit')
    expect(git(repo, 'show', `${lostSha}:feature.txt`)).toBe('important work\n')
  })

  it('preserves uncommitted changes with byte-identical content', async () => {
    const a = makeWorktree('a')
    const content = 'work in progress, never committed\nline two\n'
    writeFileSync(join(a.path, 'tracked.txt'), content)

    const preserved = await preserveWorktreeWork(repo, a.path, a.branch)

    const uncommittedRef = preserved.refs.find((r) => r.endsWith('/uncommitted'))
    expect(uncommittedRef).toBeTruthy()

    git(repo, 'worktree', 'remove', '--force', a.path)
    git(repo, 'branch', '-D', a.branch)
    git(repo, 'reflog', 'expire', '--expire=now', '--all')
    git(repo, 'gc', '--prune=now', '--quiet')

    // Recovered byte-for-byte from the preserved ref.
    expect(git(repo, 'show', `${uncommittedRef}:tracked.txt`)).toBe(content)
  })

  it('preserves an untracked file', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'untracked.txt'), 'brand new\n')

    const preserved = await preserveWorktreeWork(repo, a.path, a.branch)
    const uncommittedRef = preserved.refs.find((r) => r.endsWith('/uncommitted'))
    expect(uncommittedRef).toBeTruthy()

    git(repo, 'worktree', 'remove', '--force', a.path)
    git(repo, 'gc', '--prune=now', '--quiet')

    expect(git(repo, 'show', `${uncommittedRef}:untracked.txt`)).toBe('brand new\n')
  })

  // Preservation must be invisible to the worktree it rescues: an agent may
  // still be working in it.
  it('does not disturb the worktree it preserves', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'wip.txt'), 'in progress\n')
    writeFileSync(join(a.path, 'tracked.txt'), 'modified\n')

    const headBefore = git(a.path, 'rev-parse', 'HEAD').trim()
    const statusBefore = git(a.path, 'status', '--porcelain')
    const stashListBefore = git(a.path, 'stash', 'list')

    await preserveWorktreeWork(repo, a.path, a.branch)

    expect(git(a.path, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(git(a.path, 'status', '--porcelain')).toBe(statusBefore)
    // `stash create` must not push onto the stash list.
    expect(git(a.path, 'stash', 'list')).toBe(stashListBefore)
    // The files are still on disk, unchanged.
    expect(readFileSync(join(a.path, 'wip.txt'), 'utf-8')).toBe('in progress\n')
    expect(readFileSync(join(a.path, 'tracked.txt'), 'utf-8')).toBe('modified\n')
  })

  it('makes preserved work discoverable without knowing the ref convention', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'feature.txt'), 'work\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'discoverable work')
    await preserveWorktreeWork(repo, a.path, a.branch)

    const listed = await listPreservedWork(repo)

    expect(listed.length).toBeGreaterThan(0)
    expect(listed.some((e) => e.subject === 'discoverable work')).toBe(true)
    expect(listed.every((e) => e.ref.startsWith('refs/ion/discarded/'))).toBe(true)
  })

  it('handles a clean worktree without inventing an uncommitted ref', async () => {
    const a = makeWorktree('a')

    const preserved = await preserveWorktreeWork(repo, a.path, a.branch)

    expect(preserved.error).toBeUndefined()
    expect(preserved.refs.some((r) => r.endsWith('/head'))).toBe(true)
    expect(preserved.refs.some((r) => r.endsWith('/uncommitted'))).toBe(false)
  })

  it('keeps preserved work from separate discards separate', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'first.txt'), 'first\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'first discard')
    await preserveWorktreeWork(repo, a.path, a.branch)

    const b = makeWorktree('b')
    writeFileSync(join(b.path, 'second.txt'), 'second\n')
    git(b.path, 'add', '-A')
    git(b.path, 'commit', '-m', 'second discard')
    await preserveWorktreeWork(repo, b.path, b.branch)

    const listed = await listPreservedWork(repo)
    const subjects = listed.map((e) => e.subject)
    expect(subjects).toContain('first discard')
    expect(subjects).toContain('second discard')
  })
})

describe('the destructive pair, demonstrated', () => {
  // Documents WHY preservation is required: without it, force-remove plus
  // branch -D genuinely loses the commit. If this test ever fails because the
  // commit survives on its own, the preservation layer can be reconsidered.
  it('force-remove plus branch -D loses an unlanded commit without preservation', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'doomed.txt'), 'about to be lost\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'doomed work')
    const doomedSha = git(a.path, 'rev-parse', 'HEAD').trim()

    // No preservation this time.
    git(repo, 'worktree', 'remove', '--force', a.path)
    git(repo, 'branch', '-D', a.branch)
    git(repo, 'reflog', 'expire', '--expire=now', '--all')
    git(repo, 'gc', '--prune=now', '--quiet')

    let survived = true
    try {
      git(repo, 'cat-file', '-e', `${doomedSha}^{commit}`)
    } catch {
      survived = false
    }
    expect(survived).toBe(false)
    expect(existsSync(a.path)).toBe(false)
  })
})
