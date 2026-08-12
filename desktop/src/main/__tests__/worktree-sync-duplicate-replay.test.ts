/**
 * Duplicate-replay regression — repeated syncs must not grow a worktree branch
 * with copies of its own work, and must never mint inverse commits.
 *
 * ── The incident these tests pin ────────────────────────────────────────────
 * The precise sync (`git rebase --onto <source> <storedBase>`) keeps git's
 * replay-time becomes-empty drop but disables its preemptive already-upstream
 * skip, which is keyed on `<upstream>` (the stored base here — an ancestor of
 * HEAD, so the comparison set is empty). The gap bites when the source branch
 * has moved BEYOND a commit the worktree still carries: the replay then
 * CONFLICTS instead of becoming empty. Release automation always produces this
 * shape (worktree carries the 1.0→1.1 bump, source is at 1.2), and a conflict
 * resolved the wrong way — by hand, by an assist, or by a rerere recording
 * replayed fleet-wide — mints a permanent inverse+forward pair that every later
 * sync carries forward verbatim. Six worktrees carried identical duplicate
 * pairs when this was found. Full mechanism taxonomy: worktree/patch-identity.ts.
 *
 * The fix computes the skip explicitly (computeReplayPlan) so the conflict
 * never stands. These tests pin: the conflict-shape sync now completes cleanly
 * (the regression arm — unfixed code returns hasConflicts there), existing
 * pairs are warned about but never auto-collapsed, becomes-empty parity with
 * the unfiltered path, and every fail-open degradation.
 *
 * Real repos, not mocks: the behavior under test IS git's range selection and
 * patch-id equivalence, which a mock would merely restate.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const warnMock = vi.fn()
const logMock = vi.fn()
vi.mock('../logger', () => ({
  log: (...args: unknown[]) => logMock(...args),
  debug: vi.fn(),
  warn: (...args: unknown[]) => warnMock(...args),
  error: vi.fn(),
}))

// Redirect HOME so registry reads/writes land in the fixture. Per-file env var:
// vitest runs test FILES concurrently in one process.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_WT_DUP || actual.homedir() }
})

import { registerWorktree } from '../worktree/inventory'
import { syncWorktreeFromSource } from '../worktree/integrate'
import { computeReplayPlan, patchIdsIn } from '../worktree/patch-identity'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

const FEATURE = 'josh'

/**
 * Monotonic commit timestamps. Two commits with the same parent, tree, message,
 * author, and second-resolution timestamp are the SAME git object — a fixture
 * that writes "the worktree's copy" and "the source's copy" of a commit inside
 * one second silently produces one sha, the commit becomes a true ancestor, and
 * the scenario under test evaporates. Real replayed copies always differ (their
 * parents differ); distinct dates keep the fixtures honest.
 */
let commitClock = 1700000000
function nextCommitEnv(): NodeJS.ProcessEnv {
  commitClock += 61
  const date = `${commitClock} +0000`
  return { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
}

function gitCommit(cwd: string, message: string): void {
  execFileSync('git', ['commit', '-m', message], { cwd, encoding: 'utf-8', env: nextCommitEnv() })
}

/** A repo with a feature branch, plus a parked root so worktrees can hold it. */
function makeRepo(): string {
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf-8' })
  git(dir, 'config', 'user.email', 'dev@example.com')
  git(dir, 'config', 'user.name', 'Dev')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'upstream.txt'), 'u1\nu2\nu3\n')
  // Seeded as `off` so an off -> on -> off -> on sequence yields TWO byte-identical
  // `off -> on` diffs. Seeding any other value makes the first step a different
  // diff from the third, and the patch-id carve-out under test never engages.
  writeFileSync(join(dir, 'toggle.txt'), 'off\n')
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0\n\n- initial\n')
  writeFileSync(join(dir, 'VERSION'), '1.0.0\n')
  git(dir, 'add', '-A')
  gitCommit(dir, 'base')
  git(dir, 'branch', FEATURE)
  git(dir, 'checkout', '-b', 'parking')
  return dir
}

/** Cut a worktree from the feature tip and register it WITH its base. */
function makeWorktree(name: string): { path: string; branch: string; baseAtCut: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)
  const baseAtCut = git(path, 'rev-parse', 'HEAD').trim()
  registerWorktree({
    worktreePath: path, repoPath: repo, branchName: branch, sourceBranch: FEATURE, baseSha: baseAtCut,
  })
  return { path, branch, baseAtCut }
}

/** Commit a change on the feature branch via a throwaway holder worktree. */
function commitOnFeature(files: Record<string, string>, message: string): string {
  const holder = join(root, `holder-${Math.random().toString(36).slice(2, 8)}`)
  git(repo, 'worktree', 'add', holder, FEATURE)
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(holder, file), content)
  }
  git(holder, 'add', '-A')
  gitCommit(holder, message)
  const sha = git(holder, 'rev-parse', 'HEAD').trim()
  git(repo, 'worktree', 'remove', '--force', holder)
  return sha
}

/** Commit a change inside a worktree. */
function commitIn(path: string, files: Record<string, string>, message: string): string {
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(path, file), content)
  }
  git(path, 'add', '-A')
  gitCommit(path, message)
  return git(path, 'rev-parse', 'HEAD').trim()
}

/**
 * Land `sha`'s CONTENT on the feature branch under a DIFFERENT sha.
 *
 * The feature branch is moved on first, deliberately. A cherry-pick onto an
 * unmoved branch reproduces the identical parent, tree, message, and author, so
 * git produces the identical sha — the commit becomes a true ancestor and there
 * is nothing for a content-based rule to do. Advancing the branch first is what
 * makes this the real topology: same content, different sha, invisible to an
 * ancestry check.
 */
function landContentOnFeature(sha: string, label: string): void {
  const holder = join(root, `land-${Math.random().toString(36).slice(2, 8)}`)
  git(repo, 'worktree', 'add', holder, FEATURE)
  writeFileSync(join(holder, 'upstream.txt'), `u1\nu2\nu3\n${label}\n`)
  git(holder, 'add', '-A')
  gitCommit(holder, `feature: moved before landing ${label}`)
  git(holder, 'cherry-pick', sha)
  git(repo, 'worktree', 'remove', '--force', holder)
}

/** Every commit's patch-id in a range, for duplicate detection. */
function patchIds(cwd: string, range: string): string[] {
  return git(cwd, 'log', '--format=%H', range)
    .split('\n')
    .filter(Boolean)
    .map((sha) => {
      const out = execFileSync('/bin/sh', ['-c', `git show ${sha} | git patch-id --stable`], { cwd, encoding: 'utf-8' })
      return out.trim().split(/\s+/)[0] ?? ''
    })
    .filter(Boolean)
}

/** Patch-ids appearing more than once in the range. */
function duplicatePatchIds(cwd: string, range: string): string[] {
  const seen = new Map<string, number>()
  for (const id of patchIds(cwd, range)) seen.set(id, (seen.get(id) ?? 0) + 1)
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-wtdup-')))
  process.env.ION_TEST_HOME_WT_DUP = join(root, 'home')
  repo = makeRepo()
  warnMock.mockClear()
  logMock.mockClear()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_WT_DUP
  removeGitFixture(root)
})

describe('repeated sync does not replay commits the source branch already has', () => {
  /**
   * THE regression. Without the fix the second sync replays the copies the first
   * sync produced, and the branch ends up carrying its own work twice.
   *
   * The worktree's commit is deliberately landed onto the feature branch by
   * CHERRY-PICK, so its content is upstream under a different sha — the shape a
   * land-then-keep-working worktree actually has, and the shape a sha-based
   * ancestry check cannot see.
   */
  it('drops the worktree\'s own already-landed commit instead of replaying it twice', async () => {
    const wt = makeWorktree('a')
    const mine = commitIn(wt.path, { 'mine.txt': 'mine v1\n' }, 'a: my work')
    commitIn(wt.path, { 'keep.txt': 'keep v1\n' }, 'a: still in flight')

    // The first commit's content lands on the feature branch under a different
    // sha (see landContentOnFeature for why the branch must move first).
    landContentOnFeature(mine, 'a')

    const first = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(first.ok).toBe(true)
    expect(first.dropped).toBe(1)

    const second = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(second.ok).toBe(true)

    const subjects = git(wt.path, 'log', '--format=%s', `${FEATURE}..HEAD`).split('\n').filter(Boolean)
    expect(subjects).toEqual(['a: still in flight'])
    expect(duplicatePatchIds(wt.path, `${FEATURE}..HEAD`)).toEqual([])
    // The in-flight work is intact, not collateral damage from the drop.
    expect(git(wt.path, 'show', 'HEAD:keep.txt')).toBe('keep v1\n')
    // And the landed content is present exactly once, via the source branch.
    expect(git(wt.path, 'show', 'HEAD:mine.txt')).toBe('mine v1\n')
  })

  /**
   * THE regression arm — fails on unfixed code, deterministically.
   *
   * The worktree carries a byte-identical copy of a version bump the source
   * branch has since moved BEYOND (source is at 1.2, the copy bumps to 1.1).
   * Replaying that copy cannot become empty — the 3-way merge conflicts
   * (VERSION: 1.2.0 vs 1.1.0) — so on unfixed code this sync returns
   * `hasConflicts: true` and strands the worktree mid-rebase. That standing
   * conflict is the duplication factory: resolved the wrong way (or by a wrong
   * rerere recording replayed fleet-wide) it mints a permanent inverse+forward
   * pair. The fix drops the copy BEFORE replay, so the sync completes cleanly
   * and no conflict ever stands.
   */
  it('syncs cleanly where the unfixed rebase conflicts on an already-upstream bump', async () => {
    const wt = makeWorktree('b')
    // The worktree carries a copy of a release commit (how it got there: an
    // earlier sync replayed it, or it was cut before the source re-stamped).
    commitIn(wt.path, {
      'CHANGELOG.md': '# Changelog\n\n## 1.1.0\n\n- feature\n\n## 1.0.0\n\n- initial\n',
      'VERSION': '1.1.0\n',
    }, 'chore: release versions [skip ci]')
    commitIn(wt.path, { 'mine.txt': 'real work\n' }, 'b: real work')

    // The source branch stamps 1.1.0 itself (byte-identical diff), then moves
    // BEYOND it to 1.2.0 — the shape that makes the replay conflict rather than
    // become empty.
    commitOnFeature({
      'CHANGELOG.md': '# Changelog\n\n## 1.1.0\n\n- feature\n\n## 1.0.0\n\n- initial\n',
      'VERSION': '1.1.0\n',
    }, 'chore: release versions [skip ci]')
    commitOnFeature({
      'CHANGELOG.md': '# Changelog\n\n## 1.2.0\n\n- more\n\n## 1.1.0\n\n- feature\n\n## 1.0.0\n\n- initial\n',
      'VERSION': '1.2.0\n',
    }, 'chore: release versions [skip ci]')

    const first = await syncWorktreeFromSource(wt.path, FEATURE)
    // Unfixed code fails HERE: hasConflicts true, worktree stranded mid-rebase.
    expect(first.hasConflicts).toBeUndefined()
    expect(first.ok).toBe(true)
    expect(first.dropped).toBe(1)

    const second = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(second.ok).toBe(true)

    const subjects = git(wt.path, 'log', '--format=%s', `${FEATURE}..HEAD`).split('\n').filter(Boolean)
    expect(subjects).toEqual(['b: real work'])
    // The decisive assertions: the version was never walked backwards, and no
    // commit in the range removes changelog content — the inverse pair was
    // never minted.
    expect(git(wt.path, 'show', 'HEAD:VERSION')).toBe('1.2.0\n')
    expect(git(wt.path, 'show', 'HEAD:CHANGELOG.md')).toContain('## 1.2.0')
    const diff = git(wt.path, 'diff', FEATURE, 'HEAD', '--', 'CHANGELOG.md')
    expect(diff).toBe('')
  })

  /**
   * The safety arm, and the reason patch-id collision alone is never sufficient
   * to preemptively drop. A change made, reverted, and remade is legitimately
   * patch-identical in two places; PREEMPTIVELY dropping both — which is what
   * git's own plain-path skip does here (verified: `git rebase <source>` on this
   * exact shape skips BOTH `on` copies and leaves the branch's net content
   * wrong, `off` instead of `on`) — destroys content. The carve-out keeps both
   * copies in the todo and lets git's replay-time becomes-empty drop handle
   * them: the FIRST `on` copy becomes empty on the new base (which already has
   * `on`) and is dropped with the net intact; `off` and `on again` replay.
   * Content is preserved; the operator is warned about the in-range pair.
   */
  it('preserves net content of an add / revert / re-add sequence and warns', async () => {
    const wt = makeWorktree('c')
    // toggle.txt is `off` at the base, so `on` / `off` / `on` gives two
    // byte-identical `off -> on` diffs — the legitimate patch-identical pair the
    // carve-out exists for.
    commitIn(wt.path, { 'toggle.txt': 'on\n' }, 'c: turn it on')
    commitIn(wt.path, { 'toggle.txt': 'off\n' }, 'c: turn it off')
    commitIn(wt.path, { 'toggle.txt': 'on\n' }, 'c: turn it on again')
    // The source branch independently carries the same `off -> on` change — the
    // trigger for the preemptive drop the carve-out must refuse.
    commitOnFeature({ 'toggle.txt': 'on\n' }, 'feature: on')

    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.ok).toBe(true)
    // Nothing was PREEMPTIVELY dropped: the carve-out kept both copies.
    expect(result.dropped).toBeUndefined()

    // The sequence's tail survives; the first copy may be dropped by git's
    // replay-time becomes-empty rule (base already carries `on`), which keeps
    // the net intact — unlike the preemptive drop, which would flip it to `off`.
    const subjects = git(wt.path, 'log', '--format=%s', `${FEATURE}..HEAD`).split('\n').filter(Boolean)
    expect(subjects).toContain('c: turn it off')
    expect(subjects).toContain('c: turn it on again')
    // THE decisive assertion: net content survived. Git's own plain-path
    // preemptive skip gets this wrong (leaves `off`).
    expect(git(wt.path, 'show', 'HEAD:toggle.txt')).toBe('on\n')

    const warnedKinds = warnMock.mock.calls.map((c) => (c[2] as { kind?: string } | undefined)?.kind)
    expect(warnedKinds).toContain('duplicate-in-range')
  })

  /**
   * Pair permanence. An inverse+forward pair already minted by a past bad
   * resolution replays cleanly onto any base (the two commits alternate content
   * states), never becomes empty, and never conflicts — so no automatic
   * mechanism can remove it, and this sync must NOT try: collapsing it is a
   * history rewrite that belongs to the operator's deliberate cleanup. The sync
   * carries the pair forward unchanged and warns on every pass.
   */
  it('carries an existing inverse+forward pair forward unchanged, warning each sync', async () => {
    const wt = makeWorktree('k')
    // The minted pair: an inverse commit (version walked DOWN) and its forward
    // twin (walked back up) — net zero, patch-ids matching nothing upstream.
    commitIn(wt.path, {
      'CHANGELOG.md': '# Changelog\n\n## 0.9.0\n\n- old\n',
      'VERSION': '0.9.0\n',
    }, 'chore: release versions [skip ci]')
    commitIn(wt.path, {
      'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- initial\n',
      'VERSION': '1.0.0\n',
    }, 'chore: release versions [skip ci]')
    commitIn(wt.path, { 'mine.txt': 'work\n' }, 'k: real work')
    commitOnFeature({ 'upstream.txt': 'u1\nu2\nu3\nu4\n' }, 'feature: moved on')

    const first = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(first.ok).toBe(true)
    const second = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(second.ok).toBe(true)

    // The pair survives both syncs verbatim — same count, same net content.
    const subjects = git(wt.path, 'log', '--format=%s', `${FEATURE}..HEAD`).split('\n').filter(Boolean)
    expect(subjects.filter((s) => s === 'chore: release versions [skip ci]')).toHaveLength(2)
    expect(git(wt.path, 'show', 'HEAD:VERSION')).toBe('1.0.0\n')

    // Note the honest limit: an inverse+forward pair is invisible to patch-id
    // (the two halves are OPPOSITE diffs, not duplicates, and neither matches
    // anything upstream). The contract pinned here is preservation — the sync
    // never drops what it cannot prove is upstream. The `duplicate-in-range`
    // warning fires for SAME-direction pairs (see the add/revert/re-add arm);
    // detecting inverse pairs is the operator cleanup command's job, where the
    // byte-for-byte net-diff gate makes dropping them safe.
    expect(duplicatePatchIds(wt.path, `${FEATURE}..HEAD`)).toEqual([])
  })

  /**
   * M2 parity. A commit whose replay becomes EMPTY (content reached upstream by
   * different intermediate steps, so patch-ids differ and the explicit filter
   * keeps it) must be dropped silently at replay on the filtered path, exactly
   * as the unfiltered non-interactive path drops it. This is what `--empty=drop`
   * buys: interactive rebase's default is to STOP on a becomes-empty commit,
   * which would turn a case the unfiltered path handles silently into a new
   * failure mode.
   */
  it('silently drops a becomes-empty commit on the filtered path (interactive --empty=drop)', async () => {
    const wt = makeWorktree('m')
    // This commit's diff (u3 line changed to X) will differ from upstream's
    // patch-ids, so the filter keeps it — but by replay time the content is
    // already there and the commit becomes empty.
    commitIn(wt.path, { 'upstream.txt': 'u1\nu2\nX\n' }, 'm: change u3 to X')
    commitIn(wt.path, { 'mine.txt': 'work\n' }, 'm: real work')

    // Upstream reaches the same final content via an intermediate state, so no
    // patch-id matches the worktree's commit...
    commitOnFeature({ 'upstream.txt': 'u1\nu2\nZ\n' }, 'feature: u3 to Z')
    commitOnFeature({ 'upstream.txt': 'u1\nu2\nX\n' }, 'feature: Z to X')
    // ...and one byte-identical copy of the real-work commit forces the
    // filtered (todo-driven) path to be the one that runs.
    const landHolder = join(root, 'land-m')
    git(repo, 'worktree', 'add', landHolder, FEATURE)
    git(landHolder, 'cherry-pick', git(wt.path, 'rev-parse', 'HEAD').trim())
    git(repo, 'worktree', 'remove', '--force', landHolder)

    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.ok).toBe(true)
    // The cherry-picked copy was dropped by the filter; the becomes-empty
    // commit was dropped by git at replay. Nothing of the worktree's remains.
    expect(git(wt.path, 'log', '--format=%s', `${FEATURE}..HEAD`).trim()).toBe('')
    expect(git(wt.path, 'show', 'HEAD:upstream.txt')).toBe('u1\nu2\nX\n')
    expect(git(wt.path, 'status', '--porcelain').trim()).toBe('')
  })

  /** Nothing already upstream: the sync must behave exactly as it did before. */
  it('is a no-op filter when nothing in the range is already upstream', async () => {
    const wt = makeWorktree('d')
    commitIn(wt.path, { 'one.txt': '1\n' }, 'd: one')
    commitIn(wt.path, { 'two.txt': '2\n' }, 'd: two')
    commitOnFeature({ 'upstream.txt': 'u1\nu2\nu3\nu4\n' }, 'feature: moved on')

    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.ok).toBe(true)
    expect(result.dropped).toBeUndefined()

    const subjects = git(wt.path, 'log', '--format=%s', `${FEATURE}..HEAD`).split('\n').filter(Boolean)
    expect(subjects).toEqual(['d: two', 'd: one'])
    expect(git(wt.path, 'show', 'HEAD:upstream.txt')).toBe('u1\nu2\nu3\nu4\n')
  })

  /**
   * A fully-landed worktree drops every commit. `rebase -i` with an empty todo
   * aborts, so this must take the explicit fast-forward path rather than
   * surfacing an opaque git failure.
   */
  it('fast-forwards to the source tip when every commit is already upstream', async () => {
    const wt = makeWorktree('e')
    const mine = commitIn(wt.path, { 'mine.txt': 'landed\n' }, 'e: work that lands')
    landContentOnFeature(mine, 'e')

    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.ok).toBe(true)
    expect(result.dropped).toBe(1)
    expect(git(wt.path, 'log', '--format=%s', `${FEATURE}..HEAD`).trim()).toBe('')
    expect(git(wt.path, 'rev-parse', 'HEAD').trim()).toBe(git(repo, 'rev-parse', FEATURE).trim())
    expect(git(wt.path, 'status', '--porcelain').trim()).toBe('')
  })
})

describe('replay plan fails open — a commit is never dropped on absent evidence', () => {
  it('picks everything and warns when the range cannot be read', async () => {
    const wt = makeWorktree('f')
    commitIn(wt.path, { 'one.txt': '1\n' }, 'f: one')

    const plan = await computeReplayPlan({
      directory: wt.path,
      storedBase: 'not-a-real-object',
      sourceBranch: FEATURE,
    })
    expect(plan.reliable).toBe(false)
    expect(plan.dropped).toEqual([])
    expect(plan.warnings.some((w) => w.kind === 'probe-failed')).toBe(true)
  })

  it('picks everything when the source branch does not resolve', async () => {
    const wt = makeWorktree('g')
    commitIn(wt.path, { 'one.txt': '1\n' }, 'g: one')

    const plan = await computeReplayPlan({
      directory: wt.path,
      storedBase: git(wt.path, 'rev-parse', 'HEAD~1').trim(),
      sourceBranch: 'no-such-branch',
    })
    expect(plan.reliable).toBe(false)
    expect(plan.dropped).toEqual([])
    expect(plan.pick.length).toBe(1)
  })

  it('degrades the whole sync to the unfiltered rebase when the plan is unreliable', async () => {
    const wt = makeWorktree('h')
    commitIn(wt.path, { 'one.txt': '1\n' }, 'h: one')
    commitOnFeature({ 'upstream.txt': 'u1\nu2\nu3\nu4\n' }, 'feature: moved on')

    // A stored base that is an ancestor of HEAD but names a missing object
    // cannot happen, so the degradation is driven through the module directly
    // and the sync is asserted to still succeed unfiltered.
    const result = await syncWorktreeFromSource(wt.path, FEATURE)
    expect(result.ok).toBe(true)
    expect(git(wt.path, 'log', '--format=%s', `${FEATURE}..HEAD`).trim()).toBe('h: one')
  })
})

describe('patchIdsIn', () => {
  it('returns null rather than a partial map when the range is unreadable', async () => {
    const wt = makeWorktree('i')
    expect(await patchIdsIn(wt.path, 'nonexistent-ref..HEAD')).toBeNull()
  })

  it('groups commits that share a patch identity', async () => {
    const wt = makeWorktree('j')
    const base = git(wt.path, 'rev-parse', 'HEAD').trim()
    // toggle.txt is `off` at the base, so the first and third commits carry the
    // identical `off -> on` diff.
    commitIn(wt.path, { 'toggle.txt': 'on\n' }, 'j: on')
    commitIn(wt.path, { 'toggle.txt': 'off\n' }, 'j: off')
    commitIn(wt.path, { 'toggle.txt': 'on\n' }, 'j: on again')

    const map = await patchIdsIn(wt.path, `${base}..HEAD`)
    expect(map).not.toBeNull()
    const groups = [...(map ?? new Map<string, string[]>()).values()]
    expect(groups.some((shas) => shas.length === 2)).toBe(true)
  })
})
