/**
 * Worktree land / sync / retire / re-attach — against REAL git repositories.
 *
 * These use temp repos rather than mocks because the behavior under test IS
 * git's behavior: whether a second land fast-forwards, whether a checkout gets
 * clobbered, whether a ref advance touches a working tree. A mocked `runGit`
 * would only assert that we call the commands we already decided to call.
 *
 * Each test names the defect it pins. The three land tests at the top are the
 * regression tests for the original implementation, which did:
 *     git checkout <sourceBranch> && git merge --ff-only <wtBranch>
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME so reattachWorktree (which creates worktrees under
// ~/.ion/worktrees) and the bench/registry writers land in a fixture instead of
// the developer's real ~/.ion. Per-file env var: vitest runs test FILES
// concurrently in one process, so a shared name lets files clobber each other.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_WT_LIFECYCLE || actual.homedir() }
})

import { landWorktree, syncWorktreeFromSource, findWorktreeForBranch, parseWorktreeList } from '../worktree/integrate'
import { retireWorktree, reattachWorktree } from '../worktree/relocate'
import * as recovery from '../worktree/recovery'
import { writeRecoveryRef } from '../worktree/recovery'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

/** A repo on `main` with one commit, plus deterministic identity/config. */
function makeRepo(): string {
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf-8' })
  git(dir, 'config', 'user.email', 'dev@example.com')
  git(dir, 'config', 'user.name', 'Dev')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  return dir
}

/**
 * Scratch index files the recovery snapshot may have left in the repo's git dir.
 * Named with a timestamp, so a leak accumulates rather than overwrites.
 */
function recoveryIndexFiles(): string[] {
  const gitDir = git(repo, 'rev-parse', '--absolute-git-dir').trim()
  return readdirSync(gitDir).filter((f) => f.startsWith('ion-recovery-index-'))
}

/** Add a worktree on a new branch cut from `from`, with one commit in it. */
function makeWorktree(name: string, from = 'main', file = `${name}.txt`): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, from)
  writeFileSync(join(path, file), `${name}\n`)
  git(path, 'add', '-A')
  git(path, 'commit', '-m', `${name} work`)
  return { path, branch }
}

beforeEach(() => {
  // realpath: on macOS /var is a symlink to /private/var, and git reports
  // resolved paths — so the fixture must use the resolved root to compare.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-wt-')))
  process.env.ION_TEST_HOME_WT_LIFECYCLE = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_WT_LIFECYCLE
  rmSync(root, { recursive: true, force: true })
})

describe('landWorktree — repeatability', () => {
  // THE regression test for defect 2. The original --ff-only strategy makes
  // the second land impossible once another worktree has landed in between.
  it('lands twice in a row with another worktree landing in between', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')

    const first = await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })
    expect(first.ok).toBe(true)

    const second = await landWorktree({ repoPath: repo, worktreePath: b.path, worktreeBranch: b.branch, sourceBranch: 'main' })
    expect(second.ok).toBe(true)

    // A's second land: its branch has NOT seen B's commit, so this is exactly
    // the case --ff-only rejected.
    writeFileSync(join(a.path, 'a2.txt'), 'more a\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a more work')

    const third = await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })

    expect(third.ok).toBe(true)
    // All three contributions are on main.
    const files = git(repo, 'ls-tree', '--name-only', 'main')
    expect(files).toContain('a.txt')
    expect(files).toContain('b.txt')
    expect(files).toContain('a2.txt')
  })
})

describe('landWorktree — checkout safety', () => {
  // Regression test for defect 3. The old code ran `git checkout main` in the
  // main repo unconditionally, which either failed or clobbered the tree.
  it('refuses when the source branch is checked out and dirty, leaving the tree untouched', async () => {
    const a = makeWorktree('a')

    // main is checked out in the repo root (git init leaves it so) and dirty.
    writeFileSync(join(repo, 'in-progress.txt'), 'operator work in flight\n')
    const headBefore = git(repo, 'rev-parse', 'HEAD').trim()

    const result = await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/uncommitted changes/i)
    // Nothing moved and nothing was destroyed.
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(readFileSync(join(repo, 'in-progress.txt'), 'utf-8')).toBe('operator work in flight\n')
  })

  it('merges in place in the worktree holding the source branch, without checking anything out', async () => {
    const a = makeWorktree('a')
    // The repo root holds `main` and is clean.
    const branchBefore = git(repo, 'branch', '--show-current').trim()

    const result = await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })

    expect(result.ok).toBe(true)
    expect(result.mode).toBe('merge')
    // The holder's checked-out branch is unchanged — we merged where the
    // branch lives rather than dragging a checkout onto it.
    expect(git(repo, 'branch', '--show-current').trim()).toBe(branchBefore)
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
  })

  // The zero-impact path: when nobody has the source branch checked out, the
  // ref is advanced directly and no working tree is touched at all.
  it('advances the ref when the source branch is checked out nowhere', async () => {
    // Move the repo root off `main` so no worktree holds it.
    git(repo, 'checkout', '-b', 'parking')
    const a = makeWorktree('a', 'main')

    const parkingHeadBefore = git(repo, 'rev-parse', 'HEAD').trim()
    const result = await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })

    expect(result.ok).toBe(true)
    expect(result.mode).toBe('ref-advance')
    // main now points at the worktree's commit …
    expect(git(repo, 'rev-parse', 'main').trim()).toBe(git(a.path, 'rev-parse', 'HEAD').trim())
    // … and the operator's own checkout never moved.
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(parkingHeadBefore)
    expect(git(repo, 'branch', '--show-current').trim()).toBe('parking')
    expect(existsSync(join(repo, 'a.txt'))).toBe(false)
  })
})

describe('landWorktree — commit gate', () => {
  it('refuses to land a worktree with uncommitted changes', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'uncommitted.txt'), 'not ready\n')

    const result = await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/commit the changes/i)
  })
})

describe('landWorktree — conflicts', () => {
  it('reports a conflict as a conflict rather than a raw git error', async () => {
    // Both worktrees touch the same file with different content.
    const a = makeWorktree('a', 'main', 'shared.txt')
    const b = makeWorktree('b', 'main', 'shared.txt')

    const first = await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })
    expect(first.ok).toBe(true)

    const second = await landWorktree({ repoPath: repo, worktreePath: b.path, worktreeBranch: b.branch, sourceBranch: 'main' })

    expect(second.ok).toBe(false)
    expect(second.hasConflicts).toBe(true)
    expect(second.error).toMatch(/conflict/i)
  })
})

describe('syncWorktreeFromSource', () => {
  it('brings the source branch commits into the worktree', async () => {
    const a = makeWorktree('a')

    // main moves on independently.
    writeFileSync(join(repo, 'from-main.txt'), 'main moved\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'main moves on')

    const result = await syncWorktreeFromSource(a.path, 'main')

    expect(result.ok).toBe(true)
    expect(existsSync(join(a.path, 'from-main.txt'))).toBe(true)
    // The worktree's own work survived the rebase.
    expect(existsSync(join(a.path, 'a.txt'))).toBe(true)
  })
})

describe('retireWorktree', () => {
  it('removes the worktree and branch and returns the repo root to relocate into', async () => {
    const a = makeWorktree('a')
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })

    const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    expect(result.ok).toBe(true)
    expect(result.workingDirectory).toBe(repo)
    expect(existsSync(a.path)).toBe(false)
    expect(git(repo, 'branch', '--list', a.branch).trim()).toBe('')
  })

  // A retire is meant to run AFTER the work has landed. Uncommitted changes
  // mean something is wrong, so destroying them silently is unacceptable.
  it('refuses by default when the worktree has uncommitted changes', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'unsaved.txt'), 'work in progress\n')

    const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/uncommitted changes/i)
    expect(existsSync(a.path)).toBe(true)
    expect(readFileSync(join(a.path, 'unsaved.txt'), 'utf-8')).toBe('work in progress\n')
  })

  it('removes a dirty worktree when force is set', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'unsaved.txt'), 'discard me\n')

    const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch, force: true })

    expect(result.ok).toBe(true)
    expect(existsSync(a.path)).toBe(false)
  })

  // The retire confirmation promises "Work is preserved to a recovery ref
  // first". Nothing implemented that: a forced retire ran
  // `git worktree remove --force` and the uncommitted work was destroyed while
  // the dialog said it had been saved. These pin the promise.
  //
  // Regression direction: drop the writeRecoveryRef call from retireWorktree and
  // the first two go red (no ref written, content unrecoverable).
  it('preserves uncommitted work to a recovery ref before a forced removal', async () => {
    const a = makeWorktree('a')
    // A tracked modification, a staged change, and an untracked file — all three
    // are destroyed by `worktree remove --force`.
    writeFileSync(join(a.path, 'a.txt'), 'modified in place\n')
    writeFileSync(join(a.path, 'staged.txt'), 'staged content\n')
    git(a.path, 'add', 'staged.txt')
    writeFileSync(join(a.path, 'untracked.txt'), 'never added\n')

    const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch, force: true })

    expect(result.ok).toBe(true)
    expect(existsSync(a.path)).toBe(false)
    expect(result.recoveryRef).toMatch(/^refs\/ion\/recovery\//)

    // The ref lives in the PARENT repo, so it outlives the deleted directory.
    const sha = git(repo, 'rev-parse', result.recoveryRef!).trim()
    expect(sha).toMatch(/^[0-9a-f]{40}$/)

    // Every lost file is recoverable, with its exact content.
    const tree = git(repo, 'ls-tree', '-r', '--name-only', result.recoveryRef!)
    expect(tree).toContain('a.txt')
    expect(tree).toContain('staged.txt')
    expect(tree).toContain('untracked.txt')
    expect(git(repo, 'show', `${result.recoveryRef!}:a.txt`)).toBe('modified in place\n')
    expect(git(repo, 'show', `${result.recoveryRef!}:staged.txt`)).toBe('staged content\n')
    expect(git(repo, 'show', `${result.recoveryRef!}:untracked.txt`)).toBe('never added\n')
  })

  it('writes no recovery ref when a forced retire has nothing to preserve', async () => {
    const a = makeWorktree('a')
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })

    const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch, force: true })

    // An empty snapshot would be noise the operator has to reason about later.
    expect(result.ok).toBe(true)
    expect(result.recoveryRef).toBeUndefined()
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/ion/recovery').trim()).toBe('')
  })

  it('leaves the operator index untouched when snapshotting', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'staged.txt'), 'staged content\n')
    git(a.path, 'add', 'staged.txt')
    const before = git(a.path, 'status', '--porcelain')

    // Snapshot alone, without removing the worktree: the temp-index plumbing
    // must not disturb a staged-but-uncommitted state the operator is building.
    const snapshot = await writeRecoveryRef({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    expect(snapshot.snapshot).toBeDefined()
    expect(git(a.path, 'status', '--porcelain')).toBe(before)
  })

  // Git never cleans up a GIT_INDEX_FILE -- the creator owns it -- and the name
  // carries a timestamp, so a missing unlink accumulates one orphan index per
  // forced retire rather than overwriting a single file.
  //
  // Regression direction: drop the `finally` in writeRecoveryRef and both go red.
  it('leaves no scratch index behind after a snapshot', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'unsaved.txt'), 'work\n')

    const snapshot = await writeRecoveryRef({ repoPath: repo, worktreePath: a.path, branchName: a.branch })

    expect(snapshot.snapshot).toBeDefined()
    // The snapshot is durable in the object store, so the scratch index has no
    // further purpose.
    expect(recoveryIndexFiles()).toEqual([])
  })

  it('leaves no scratch index behind when the snapshot fails', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'unsaved.txt'), 'work\n')

    // A real failure, not an injected one, and specifically a LATE one. The
    // branch name is only used for the commit message and the ref slug, so
    // `wt/a..b` slugs to `wt-a..b` and `git update-ref` refuses the `..` --
    // after read-tree, update-index, write-tree and commit-tree have all run and
    // the scratch index is on disk. That is precisely the window the `finally`
    // covers. (An unborn HEAD would fail at read-tree, before the index exists,
    // and would pass this assertion without proving anything.)
    const result = await writeRecoveryRef({ repoPath: repo, worktreePath: a.path, branchName: 'wt/a..b' })

    expect(result.error).toBeDefined()
    expect(recoveryIndexFiles()).toEqual([])
  })

  // A snapshot failure must not become a silent data-loss path: the retire
  // refuses and the worktree (with its work) survives.
  it('refuses the forced retire when the recovery snapshot cannot be written', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'unsaved.txt'), 'precious\n')

    const failure = vi.spyOn(recovery, 'writeRecoveryRef')
      .mockResolvedValue({ error: 'object store is read-only' })
    try {
      const result = await retireWorktree({ repoPath: repo, worktreePath: a.path, branchName: a.branch, force: true })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/read-only/)
      expect(result.error).toMatch(/kept/i)
      // The whole point: the work is still there.
      expect(existsSync(a.path)).toBe(true)
      expect(readFileSync(join(a.path, 'unsaved.txt'), 'utf-8')).toBe('precious\n')
    } finally {
      failure.mockRestore()
    }
  })
})

describe('reattachWorktree', () => {
  it('creates a fresh worktree from the current source tip', async () => {
    // Land something so main's tip is ahead of where the first worktree began.
    const a = makeWorktree('a')
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })

    const result = await reattachWorktree({ repoPath: repo, sourceBranch: 'main' })

    expect(result.ok).toBe(true)
    expect(result.workingDirectory).toBeTruthy()
    expect(result.worktree?.sourceBranch).toBe('main')
    expect(result.worktree?.branchName).toMatch(/^wt\//)
    // It was cut from the CURRENT tip, so the landed work is present.
    expect(existsSync(join(result.workingDirectory!, 'a.txt'))).toBe(true)

    rmSync(result.workingDirectory!, { recursive: true, force: true })
  })
})

describe('worktree list parsing', () => {
  it('finds the worktree holding a branch, and reports null when none does', async () => {
    const a = makeWorktree('a')

    const holder = await findWorktreeForBranch(repo, a.branch)
    expect(holder?.path).toBe(a.path)

    expect(await findWorktreeForBranch(repo, 'no-such-branch')).toBeNull()
  })

  it('parses porcelain output including a detached entry', () => {
    const raw = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /wt/a',
      'HEAD def456',
      'detached',
      '',
    ].join('\n')

    const entries = parseWorktreeList(raw)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ path: '/repo', head: 'abc123', branch: 'main' })
    expect(entries[1]).toEqual({ path: '/wt/a', head: 'def456', branch: '' })
  })
})

describe('landWorktree — fast-forward strategy', () => {
  // The defect: the row menu passed no flags, so a "Merge (ff)" setting ran a
  // plain `git merge`. That fast-forwards when it can and SILENTLY writes a
  // merge commit when it cannot — the operator asked for linear history and got
  // a merge point with nothing on screen saying so.
  it('refuses rather than writing a merge commit when a fast-forward is impossible', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')

    // `a` lands first, so main moves and `b` is no longer a fast-forward.
    expect((await landWorktree({
      repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main',
    })).ok).toBe(true)

    const before = git(repo, 'rev-parse', 'main').trim()
    const result = await landWorktree({
      repoPath: repo, worktreePath: b.path, worktreeBranch: b.branch, sourceBranch: 'main',
      requireFastForward: true,
    })

    expect(result.ok).toBe(false)
    // The message must be actionable, not git's raw "Not possible to fast-forward".
    expect(result.error).toContain('Sync this worktree')
    // And nothing moved: no merge commit was written behind the refusal.
    expect(git(repo, 'rev-parse', 'main').trim()).toBe(before)
  })

  it('fast-forwards cleanly when the source has not moved', async () => {
    const a = makeWorktree('a')

    const result = await landWorktree({
      repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main',
      requireFastForward: true,
    })

    expect(result.ok).toBe(true)
    expect(result.mode).toBe('fast-forward')
    // A fast-forward leaves a single-parent commit: no merge point.
    expect(git(repo, 'rev-list', '--count', '--merges', 'main').trim()).toBe('0')
  })

  it('syncFirst makes a diverged branch fast-forwardable', async () => {
    // This is the pairing the merge-ff strategy ships: rebase onto the source
    // tip, which is what MAKES the fast-forward available, then require it.
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    await landWorktree({ repoPath: repo, worktreePath: a.path, worktreeBranch: a.branch, sourceBranch: 'main' })

    const result = await landWorktree({
      repoPath: repo, worktreePath: b.path, worktreeBranch: b.branch, sourceBranch: 'main',
      syncFirst: true, requireFastForward: true,
    })

    expect(result.ok).toBe(true)
    expect(result.mode).toBe('fast-forward')
    expect(git(repo, 'rev-list', '--count', '--merges', 'main').trim()).toBe('0')
  })
})
