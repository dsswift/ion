/**
 * Worktree sync mechanics — stored-base rebases and rerere replay, against
 * REAL git.
 *
 * ── The incident these tests pin ────────────────────────────────────────────
 * The operator rebased the feature branch (`josh`) onto main, which rewrote
 * its history. Every worktree cut from the old tip went base-stale at once,
 * and syncing them produced a wall of conflicts — most of them SPURIOUS,
 * because `git rebase <sourceBranch>` derives its range from the merge base,
 * which after the rewrite sits behind it: the rebase replayed stale copies of
 * upstream commits, not just each worktree's own work. And the conflicts that
 * WERE real had to be resolved a dozen times, once per worktree, because the
 * sync path never enabled rerere.
 *
 * Real repos, not mocks: the behavior under test IS git's range selection and
 * rerere's recording/replay, which a mock would just restate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME so registry reads/writes land in the fixture. Per-file env var:
// vitest runs test FILES concurrently in one process.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_WT_SYNC || actual.homedir() }
})

import {
  registerWorktree,
  lookupWorktreeBase,
  worktreeRegistryFile,
} from '../worktree/inventory'
import {
  syncWorktreeFromSource,
  completeRebaseIfReplayed,
} from '../worktree/integrate'
import { repairStaleBase } from '../worktree/base-repair'
import { probeOperationState } from '../git/operation-state'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

const FEATURE = 'josh'

/**
 * A repo whose feature branch has an upstream file the tests can move, plus a
 * parked root so worktrees can hold the feature branch when needed.
 */
function makeRepo(): string {
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf-8' })
  git(dir, 'config', 'user.email', 'dev@example.com')
  git(dir, 'config', 'user.name', 'Dev')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'upstream.txt'), 'u1\nu2\nu3\n')
  writeFileSync(join(dir, 'shared.txt'), 'line1\nline2\nline3\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  git(dir, 'branch', FEATURE)
  git(dir, 'checkout', '-b', 'parking')
  return dir
}

/** Cut a worktree from the feature tip and register it WITH its base. */
function makeWorktree(name: string, opts?: { skipBase?: boolean }): { path: string; branch: string; baseAtCut: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)
  const baseAtCut = git(path, 'rev-parse', 'HEAD').trim()
  registerWorktree({
    worktreePath: path, repoPath: repo, branchName: branch, sourceBranch: FEATURE,
    baseSha: opts?.skipBase ? undefined : baseAtCut,
  })
  return { path, branch, baseAtCut }
}

/** Commit a change on the feature branch via a throwaway holder worktree. */
function commitOnFeature(file: string, content: string, message: string): void {
  const holder = join(root, `holder-${Math.random().toString(36).slice(2, 8)}`)
  git(repo, 'worktree', 'add', holder, FEATURE)
  writeFileSync(join(holder, file), content)
  git(holder, 'add', '-A')
  git(holder, 'commit', '-m', message)
  git(repo, 'worktree', 'remove', '--force', holder)
}

/**
 * Rewrite the feature branch's history the way a rebase-onto-main does: amend
 * its tip commit so both the SHA and the CONTENT change. After this, any
 * worktree cut from the old tip has the ORIGINAL commit in its history, and a
 * plain `git rebase <feature>` — whose range starts at the merge base, which
 * now sits behind the rewrite — replays that stale copy against the rewritten
 * content and conflicts. This is exactly the incident topology: worktrees cut
 * from `josh`, then `josh` rebased onto main.
 */
function rewriteFeatureHistory(): void {
  const holder = join(root, 'rewrite-holder')
  git(repo, 'worktree', 'add', holder, FEATURE)
  writeFileSync(join(holder, 'upstream.txt'), 'u1 CHANGED v2\nu2\nu3\n')
  git(holder, 'add', '-A')
  git(holder, 'commit', '--amend', '--no-edit')
  git(repo, 'worktree', 'remove', '--force', holder)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-wtsync-')))
  process.env.ION_TEST_HOME_WT_SYNC = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_WT_SYNC
  rmSync(root, { recursive: true, force: true })
})

describe('stored-base sync — rebase --onto replays only the worktree\'s own commits', () => {
  it('syncs clean across a source-branch rewrite that the plain rebase would conflict on', async () => {
    // The worktree edits upstream.txt's u3 line — no overlap with its own work.
    const wt = makeWorktree('a')
    writeFileSync(join(wt.path, 'shared.txt'), 'line1\nWORKTREE\nline3\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: edit shared')

    // Upstream changes u1 on the feature branch, then the branch history is
    // REWRITTEN (amend) — the merge base now predates the u1 change, so a
    // plain rebase would replay against that deeper base. The precise
    // `--onto <feature> <storedBase>` rebase replays exactly one commit: the
    // worktree's own.
    rewriteFeatureHistory()

    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.ok).toBe(true)

    // The worktree now carries: base, rewritten upstream commit, its own edit.
    expect(readFileSync(join(wt.path, 'upstream.txt'), 'utf-8')).toContain('u1 CHANGED')
    expect(readFileSync(join(wt.path, 'shared.txt'), 'utf-8')).toContain('WORKTREE')
    // Exactly one commit of its own on top of the feature tip.
    const own = git(wt.path, 'rev-list', '--count', `${FEATURE}..HEAD`).trim()
    expect(own).toBe('1')
  })

  it('advances the stored base after a successful sync', async () => {
    const wt = makeWorktree('a')
    writeFileSync(join(wt.path, 'shared.txt'), 'line1\nWORKTREE\nline3\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: edit shared')
    commitOnFeature('upstream.txt', 'u1 NEW\nu2\nu3\n', 'feature: move u1')

    const tipBefore = git(repo, 'rev-parse', FEATURE).trim()
    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.ok).toBe(true)
    expect(lookupWorktreeBase(wt.path)).toBe(tipBefore)
  })

  it('backfills a legacy entry (no baseSha) on its first successful sync', async () => {
    const wt = makeWorktree('a', { skipBase: true })
    expect(lookupWorktreeBase(wt.path)).toBeNull()
    commitOnFeature('upstream.txt', 'u1 NEW\nu2\nu3\n', 'feature: move u1')

    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.ok).toBe(true)
    expect(lookupWorktreeBase(wt.path)).toBe(git(repo, 'rev-parse', FEATURE).trim())
  })

  it('falls back to the plain rebase when the stored base is not an ancestor of HEAD', async () => {
    const wt = makeWorktree('a')
    // Corrupt the record with a sha that exists but is not in this worktree's
    // history line (the parking branch tip after an unrelated commit).
    writeFileSync(join(repo, 'parking.txt'), 'x\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'parking: unrelated')
    const foreign = git(repo, 'rev-parse', 'HEAD').trim()
    const raw = JSON.parse(readFileSync(worktreeRegistryFile(), 'utf-8'))
    raw.entries.find((e: { worktreePath: string }) => e.worktreePath === wt.path).baseSha = foreign
    writeFileSync(worktreeRegistryFile(), JSON.stringify(raw))

    commitOnFeature('upstream.txt', 'u1 NEW\nu2\nu3\n', 'feature: move u1')
    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    // The fallback plain rebase handles this cleanly (no history rewrite here).
    expect(result.ok).toBe(true)
    // And the record is REPAIRED: the new base is the real feature tip.
    expect(lookupWorktreeBase(wt.path)).toBe(git(repo, 'rev-parse', FEATURE).trim())
  })
})

describe('rerere replay — resolve once, every sibling syncs free', () => {
  /** Two worktrees with the IDENTICAL conflicting edit against the feature branch. */
  function makeConflictPair(): [{ path: string; branch: string }, { path: string; branch: string }] {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    for (const wt of [a, b]) {
      writeFileSync(join(wt.path, 'shared.txt'), 'line1\nWORKTREE CHANGE\nline3\n')
      git(wt.path, 'add', '-A')
      git(wt.path, 'commit', '-m', 'edit shared')
    }
    commitOnFeature('shared.txt', 'line1\nFEATURE CHANGE\nline3\n', 'feature: conflicting edit')
    return [a, b]
  }

  it('completes the second worktree\'s sync from the first\'s recorded resolution', async () => {
    const [a, b] = makeConflictPair()

    // Worktree A conflicts for real (rerere records the conflict on the way).
    const first = await syncWorktreeFromSource(a.path, FEATURE)
    expect(first.ok).toBe(false)
    expect(first.hasConflicts).toBe(true)

    // The operator (or the AI assist) resolves it and continues — this is the
    // act that records the resolution into the shared rr-cache.
    writeFileSync(join(a.path, 'shared.txt'), 'line1\nRESOLVED\nline3\n')
    git(a.path, 'add', 'shared.txt')
    git(a.path, '-c', 'core.editor=true', 'rebase', '--continue')

    // Worktree B hits the textually identical conflict — and syncs CLEAN,
    // completed by replay. This is the cascade the whole feature exists for.
    const second = await syncWorktreeFromSource(b.path, FEATURE)
    expect(second.ok).toBe(true)
    expect(second.replayed).toBe(true)
    expect(readFileSync(join(b.path, 'shared.txt'), 'utf-8')).toContain('RESOLVED')
    const probe = await probeOperationState(b.path)
    expect(probe.state).toBeUndefined()
  })

  it('a genuinely different conflict still stops with hasConflicts', async () => {
    const [a, b] = makeConflictPair()
    const first = await syncWorktreeFromSource(a.path, FEATURE)
    expect(first.hasConflicts).toBe(true)
    writeFileSync(join(a.path, 'shared.txt'), 'line1\nRESOLVED\nline3\n')
    git(a.path, 'add', 'shared.txt')
    git(a.path, '-c', 'core.editor=true', 'rebase', '--continue')

    // B's edit is changed to a DIFFERENT conflicting line before its sync, so
    // the recorded resolution does not match its conflict text.
    git(b.path, 'reset', '--hard', 'HEAD~1')
    writeFileSync(join(b.path, 'shared.txt'), 'line1\nA DIFFERENT CHANGE\nline3\n')
    git(b.path, 'add', '-A')
    git(b.path, 'commit', '-m', 'b: different edit')

    const second = await syncWorktreeFromSource(b.path, FEATURE)
    expect(second.ok).toBe(false)
    expect(second.hasConflicts).toBe(true)
    git(b.path, 'rebase', '--abort')
  })

  it('completeRebaseIfReplayed finishes a stranded rebase once a recording covers it', async () => {
    const [a, b] = makeConflictPair()

    // B strands FIRST — mid-rebase, before any recording exists.
    const stranded = await syncWorktreeFromSource(b.path, FEATURE)
    expect(stranded.hasConflicts).toBe(true)
    expect((await probeOperationState(b.path)).state).toBe('rebasing')

    // A's conflict is then resolved, recording the resolution.
    const first = await syncWorktreeFromSource(a.path, FEATURE)
    expect(first.hasConflicts).toBe(true)
    writeFileSync(join(a.path, 'shared.txt'), 'line1\nRESOLVED\nline3\n')
    git(a.path, 'add', 'shared.txt')
    git(a.path, '-c', 'core.editor=true', 'rebase', '--continue')

    // B is still stranded with the conflict markers in its tree. rerere did
    // not replay at conflict time (no recording existed yet) — replay it now.
    git(b.path, 'checkout', '--conflict=merge', 'shared.txt')
    git(b.path, 'rerere')
    const completion = await completeRebaseIfReplayed(b.path)
    expect(completion.completed).toBe(true)
    expect((await probeOperationState(b.path)).state).toBeUndefined()
    expect(readFileSync(join(b.path, 'shared.txt'), 'utf-8')).toContain('RESOLVED')
  })

  it('completeRebaseIfReplayed leaves an uncovered conflict standing', async () => {
    const [a] = makeConflictPair()
    const stranded = await syncWorktreeFromSource(a.path, FEATURE)
    expect(stranded.hasConflicts).toBe(true)

    const completion = await completeRebaseIfReplayed(a.path)
    expect(completion.completed).toBe(false)
    expect(completion.conflictedPaths).toEqual(['shared.txt'])
    // Untouched: still mid-rebase for the resolution surfaces.
    expect((await probeOperationState(a.path)).state).toBe('rebasing')
    git(a.path, 'rebase', '--abort')
  })
})

/**
 * Untracked-obstruction self-heal — confirmed directly against real git: an
 * untracked, non-ignored file sitting at a path a LATER rebase step wants to
 * write causes `rebase --continue` to fail with git's own "would be
 * overwritten by rebase" error, a DIFFERENT failure shape than a real
 * conflict (`ls-files --unmerged` is empty — nothing here is a content
 * collision). Reproduced with a two-commit worktree branch: the first commit
 * conflicts for real (so the rebase genuinely stops mid-sequence), then an
 * untracked file appears at the path the SECOND commit wants to write —
 * exactly the shape debris from an earlier aborted operation, or an
 * unrelated scratch file, would leave behind.
 */
describe('completeRebaseIfReplayed — untracked-obstruction self-heal', () => {
  it('removes the exact git-named blocking path and finishes the rebase', async () => {
    const wt = makeWorktree('a')
    // First commit will conflict for real against a source-branch edit.
    writeFileSync(join(wt.path, 'shared.txt'), 'line1\nWORKTREE CONFLICT\nline3\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: conflicts with feature')
    // Second commit adds a new, currently-clean file.
    writeFileSync(join(wt.path, 'blocked.txt'), 'from the worktree\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: adds blocked.txt')
    commitOnFeature('shared.txt', 'line1\nFEATURE CONFLICT\nline3\n', 'feature: conflicting edit')

    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.hasConflicts).toBe(true)
    expect((await probeOperationState(wt.path)).state).toBe('rebasing')

    // While genuinely stopped on the first commit's real conflict, an
    // untracked file appears at the SECOND commit's path — debris from
    // something else entirely, not part of this rebase's own content.
    writeFileSync(join(wt.path, 'blocked.txt'), 'PRE-EXISTING untracked debris, not from this rebase\n')
    git(wt.path, 'checkout', '--ours', 'shared.txt')
    git(wt.path, 'add', 'shared.txt')

    // RED before the fix: `completeRebaseIfReplayed`'s `--continue` call
    // would fail with git's own "would be overwritten by rebase" error, and
    // the rebase would stay stranded forever on a failure this code was
    // never checking for. After the fix: the exact named path is removed and
    // the rebase completes.
    const completion = await completeRebaseIfReplayed(wt.path)

    expect(completion.completed).toBe(true)
    expect((await probeOperationState(wt.path)).state).toBeUndefined()
    expect(readFileSync(join(wt.path, 'blocked.txt'), 'utf-8')).toBe('from the worktree\n')
  })

  // The precision guarantee: an UNRELATED untracked file elsewhere in the
  // worktree — real operator content, not debris at a colliding path — must
  // never be touched by the recovery, even while it is actively removing a
  // different, git-named blocking path in the same rebase.
  it('never touches an untracked file the rebase did not name as blocking', async () => {
    const wt = makeWorktree('a')
    writeFileSync(join(wt.path, 'shared.txt'), 'line1\nWORKTREE CONFLICT\nline3\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: conflicts with feature')
    writeFileSync(join(wt.path, 'blocked.txt'), 'from the worktree\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: adds blocked.txt')
    commitOnFeature('shared.txt', 'line1\nFEATURE CONFLICT\nline3\n', 'feature: conflicting edit')

    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.hasConflicts).toBe(true)

    writeFileSync(join(wt.path, 'blocked.txt'), 'PRE-EXISTING untracked debris\n')
    writeFileSync(join(wt.path, 'my_scratch_notes.txt'), 'operator scratch content, unrelated to this rebase\n')
    git(wt.path, 'checkout', '--ours', 'shared.txt')
    git(wt.path, 'add', 'shared.txt')

    await completeRebaseIfReplayed(wt.path)

    expect(readFileSync(join(wt.path, 'my_scratch_notes.txt'), 'utf-8'))
      .toBe('operator scratch content, unrelated to this rebase\n')
  })
})

describe('stale stored base after an out-of-band rebase completion (regression)', () => {
  /**
   * The exact incident: a worktree's rebase gets COMPLETED by something other
   * than `syncWorktreeFromSource`'s own success path — an AI conflict-assist
   * running raw `git rebase --continue` in Bash, or the operator finishing it
   * by hand. `setWorktreeBase` is called ONLY from that one success path (see
   * its doc comment), so neither of those completions ever advances it: the
   * registry keeps naming the worktree's ORIGINAL cut point as its base, even
   * though HEAD is now genuinely built on a later point of the source branch.
   *
   * That stale cut point stays an ancestor of HEAD forever (an append-only
   * source branch never invalidates ancestry), so the existing
   * `merge-base --is-ancestor <storedBase> HEAD` validity check cannot detect
   * the problem on its own — it proves reachable, not current. The next sync
   * then computes its replay range from the wrong, too-early point.
   *
   * This test proves the REPAIR runs and lands correctly, independent of
   * whatever that next sync's own outcome turns out to be: it forces the
   * second sync into a real, unrelated conflict (a fresh edit on the source
   * branch) precisely so the assertion cannot be satisfied by the ROUTINE
   * post-SUCCESS `setWorktreeBase` call at the bottom of
   * `syncWorktreeFromSource` — that call never runs on a conflicted return.
   * If the registry's base is already corrected despite the sync failing for
   * an unrelated reason, the correction can only be the pre-rebase repair
   * step, not the success-path backfill.
   */
  it('repairs a stale stored base before the rebase runs, even when that sync itself then hits an unrelated conflict', async () => {
    const wt = makeWorktree('a')
    writeFileSync(join(wt.path, 'other.txt'), 'v1\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: unrelated commit')

    // Advance the source branch, then rebase the worktree onto it WITHOUT
    // going through syncWorktreeFromSource at all — the plain-git stand-in for
    // "completed out of band" (AI assist or operator finishing it by hand).
    // No conflict needed for this step: the point is only that HEAD ends up
    // built on a later commit than the registry's stale record names.
    commitOnFeature('upstream.txt', 'u1 NEW\nu2\nu3\n', 'feature: unrelated advance')
    const trueForkPoint = git(repo, 'rev-parse', FEATURE).trim()
    git(wt.path, 'rebase', FEATURE)
    expect((await probeOperationState(wt.path)).state).toBeUndefined()

    // The registry was never told: it still names the worktree's original cut
    // point, which is now stale but still (trivially) an ancestor of HEAD.
    expect(lookupWorktreeBase(wt.path)).toBe(wt.baseAtCut)
    expect(lookupWorktreeBase(wt.path)).not.toBe(trueForkPoint)

    // A brand new, genuinely unrelated conflict on the source branch — forces
    // this sync to fail for a reason that has nothing to do with the repair.
    commitOnFeature('shared.txt', 'line1\nFEATURE CHANGE\nline3\n', 'feature: conflicting edit')
    writeFileSync(join(wt.path, 'shared.txt'), 'line1\nWORKTREE CHANGE\nline3\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: conflicting edit')

    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.ok).toBe(false)
    expect(result.hasConflicts).toBe(true)

    // The repair already landed — proven precisely because the sync FAILED,
    // so the routine post-success backfill cannot be what did this.
    expect(lookupWorktreeBase(wt.path)).toBe(trueForkPoint)

    git(wt.path, 'rebase', '--abort')
  })
})

describe('completeRebaseIfReplayed — skip safety', () => {
  it('skips an empty replay where the commit is already in the new base', async () => {
    const wt = makeWorktree('a')
    // Make a commit on the worktree that duplicates a change already on the
    // source branch — after sync, the commit is empty because the source tip
    // already contains exactly the same diff.
    commitOnFeature('upstream.txt', 'u1 CHANGED\nu2\nu3\n', 'feature: change u1')
    writeFileSync(join(wt.path, 'upstream.txt'), 'u1 CHANGED\nu2\nu3\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: same change as feature')

    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.ok).toBe(true)
    expect((await probeOperationState(wt.path)).state).toBeUndefined()
  })

  it('refuses to skip when a lock file blocks continue', async () => {
    const wt = makeWorktree('a')
    writeFileSync(join(wt.path, 'shared.txt'), 'line1\nWORKTREE EDIT\nline3\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: edit shared')
    commitOnFeature('shared.txt', 'line1\nFEATURE EDIT\nline3\n', 'feature: conflict')

    const syncResult = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(syncResult.hasConflicts).toBe(true)

    // Resolve the conflict so rerere would ordinarily auto-continue.
    writeFileSync(join(wt.path, 'shared.txt'), 'line1\nRESOLVED\nline3\n')
    git(wt.path, 'add', 'shared.txt')

    // Plant an index.lock to simulate a concurrent git process holding
    // the lock. This is git's actual lock path; the error message says
    // "Unable to create '.../index.lock': File exists."
    const gitDir = git(wt.path, 'rev-parse', '--absolute-git-dir').trim()
    const lockPath = join(gitDir, 'index.lock')
    writeFileSync(lockPath, '')

    const completion = await completeRebaseIfReplayed(wt.path)
    expect(completion.completed).toBe(false)
    expect(completion.error).toMatch(/\.lock/)

    unlinkSync(lockPath)
    git(wt.path, 'rebase', '--abort')
  })

  it('refuses to skip when continue error is unrecognized', async () => {
    const wt = makeWorktree('a')
    writeFileSync(join(wt.path, 'shared.txt'), 'line1\nWORKTREE EDIT\nline3\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-m', 'a: edit shared')
    commitOnFeature('shared.txt', 'line1\nFEATURE EDIT\nline3\n', 'feature: conflict')

    const syncResult = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(syncResult.hasConflicts).toBe(true)

    // Resolve conflict, then delete the author-script so continue fails
    // with "could not read ... author-script" — an unrecognized error
    // that is neither empty-replay, lock, nor hook.
    writeFileSync(join(wt.path, 'shared.txt'), 'line1\nRESOLVED\nline3\n')
    git(wt.path, 'add', 'shared.txt')
    const gitDir = git(wt.path, 'rev-parse', '--absolute-git-dir').trim()
    const authorScript = join(gitDir, 'rebase-merge', 'author-script')
    unlinkSync(authorScript)

    const completion = await completeRebaseIfReplayed(wt.path)
    expect(completion.completed).toBe(false)
    // Rebase state is corrupted, abort may or may not work; clean via rmSync.
  })
})

describe('repairStaleBase — the unit contract behind the regression above', () => {
  it('repairs a stale-but-reachable base to the true fork point', async () => {
    const wt = makeWorktree('a')
    commitOnFeature('upstream.txt', 'u1 NEW\nu2\nu3\n', 'feature: advance')
    const trueForkPoint = git(repo, 'rev-parse', FEATURE).trim()
    git(wt.path, 'rebase', FEATURE)

    const repaired = await repairStaleBase(wt.path, FEATURE, wt.baseAtCut)

    expect(repaired).toBe(trueForkPoint)
    expect(lookupWorktreeBase(wt.path)).toBe(trueForkPoint)
  })

  it('leaves an already-current base untouched', async () => {
    const wt = makeWorktree('a')
    const current = lookupWorktreeBase(wt.path)!

    const repaired = await repairStaleBase(wt.path, FEATURE, current)

    expect(repaired).toBe(current)
  })

  it('leaves an unrelated or corrupted base untouched rather than guessing', async () => {
    const wt = makeWorktree('a')
    // A sha that exists but shares no ancestry with this worktree's history —
    // not an ancestor of the true fork point either, so repair must not touch it.
    writeFileSync(join(repo, 'parking.txt'), 'x\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'parking: unrelated')
    const foreign = git(repo, 'rev-parse', 'HEAD').trim()

    const repaired = await repairStaleBase(wt.path, FEATURE, foreign)

    expect(repaired).toBe(foreign)
    expect(lookupWorktreeBase(wt.path)).toBe(wt.baseAtCut)
  })
})
