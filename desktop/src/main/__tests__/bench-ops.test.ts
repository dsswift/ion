/**
 * Bench workspace operations — the layer between the UI and the rebuild engine.
 *
 * The invariant these pin: **rebuild never advances a pin; only Update does.**
 * That separation is what makes "rebuild" safe to press at any moment. If
 * rebuild re-read each member's tip, pressing it to pick up member A would drag
 * in member B's half-finished change — the exact failure the pinned model
 * exists to prevent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect the workspace registry to a temp dir so tests never touch ~/.ion.
let storeDir: string
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  // Per-file env var: vitest runs test FILES concurrently in one process, so a
  // shared name would let files clobber each other's fake home -- passing in
  // isolation and failing in the suite.
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_OPS || actual.homedir() }
})

import {
  ensureWorkspace, addMember, removeMember, setMemberEnabled,
  updateMember, updateAllStale, assembleWorkspace, refreshStaleness, listWorkspaces,
  setMemberReview, setMemberOrder,
} from '../integration/bench-ops'
import { loadWorkspaces, saveWorkspaces } from '../integration/bench-store'
import { GIT_FIXTURE_TIMEOUT } from '../../test/git-fixture-timeout'

const FEATURE = 'josh'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-benchops-')))
  storeDir = join(root, 'home')
  execFileSync('mkdir', ['-p', join(storeDir, '.ion')])
  process.env.ION_TEST_HOME_BENCH_OPS = storeDir

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
  delete process.env.ION_TEST_HOME_BENCH_OPS
  rmSync(root, { recursive: true, force: true })
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

/** Point the workspace's bench at the test root instead of ~/.ion. */
function localBench(sourceBranch = FEATURE): void {
  const ws = ensureWorkspace(repo, sourceBranch)
  const all = loadWorkspaces()
  const idx = all.findIndex((w) => w.repoPath === repo && w.sourceBranch === sourceBranch)
  all[idx] = { ...ws, benchPath: join(root, 'bench'), benchBranch: `ion/bench/${sourceBranch}` }
  saveWorkspaces(all)
}

function benchPath(): string { return join(root, 'bench') }

describe('workspace lifecycle', () => {
  it('creates a workspace record without materialising a worktree', () => {
    const ws = ensureWorkspace(repo, FEATURE)

    expect(ws.sourceBranch).toBe(FEATURE)
    expect(ws.members).toHaveLength(0)
    // Creating is cheap: the bench directory appears on first rebuild.
    expect(existsSync(ws.benchPath)).toBe(false)
  })

  it('is idempotent and keyed by (repo, source branch)', () => {
    ensureWorkspace(repo, FEATURE)
    ensureWorkspace(repo, FEATURE)
    ensureWorkspace(repo, 'other-feature')

    const list = listWorkspaces(repo)
    expect(list).toHaveLength(2)
    expect(list.map((w) => w.sourceBranch).sort()).toEqual(['josh', 'other-feature'])
  })
}, GIT_FIXTURE_TIMEOUT)

describe('member management', () => {
  it('enrolls a worktree pinned at its committed contribution', async () => {
    localBench()
    const a = makeWorktree('a')

    const result = await addMember(repo, FEATURE, a.path, a.branch)

    expect(result.ok).toBe(true)
    const member = result.workspace!.members[0]
    expect(member.pinnedSha).toBe(git(a.path, 'rev-parse', 'HEAD').trim())
    expect(member.enabled).toBe(true)
  })

  // Re-enrolling would silently advance the pin, integrating newer work the
  // operator never asked to integrate.
  it('refuses a duplicate rather than silently re-pinning', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')

    const result = await addMember(repo, FEATURE, a.path, a.branch)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already a member/i)
  })

  it('removes a member without touching the worktree', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)

    const ws = removeMember(repo, FEATURE, a.path)

    expect(ws!.members).toHaveLength(0)
    expect(existsSync(a.path)).toBe(true)
    expect(git(repo, 'branch', '--list', a.branch).trim()).toContain(a.branch)
  })

  it('excludes a member without removing it from the list', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)

    const ws = setMemberEnabled(repo, FEATURE, a.path, false)

    expect(ws!.members).toHaveLength(1)
    expect(ws!.members[0].enabled).toBe(false)
  })
}, GIT_FIXTURE_TIMEOUT)

describe('rebuild never advances a pin', () => {
  // THE core guarantee, at the ops layer.
  it('leaves pins and bench content unchanged when members have moved on', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await assembleWorkspace(repo, FEATURE)
    const pinBefore = listWorkspaces(repo)[0].members[0].pinnedSha

    commitIn(a.path, 'a.txt', 'a v2 UNPINNED\n', 'a moves on')

    const result = await assembleWorkspace(repo, FEATURE)

    expect(result.ok).toBe(true)
    expect(result.workspace!.members[0].pinnedSha).toBe(pinBefore)
    expect(readFileSync(join(benchPath(), 'a.txt'), 'utf-8')).toBe('a v1\n')
  })

  it('Update advances only the targeted member', async () => {
    localBench()
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, b.path, b.branch)
    await assembleWorkspace(repo, FEATURE)
    const bPinBefore = listWorkspaces(repo)[0].members.find((m) => m.branchName === b.branch)!.pinnedSha

    commitIn(a.path, 'a.txt', 'a v2\n', 'a ready')
    commitIn(b.path, 'b.txt', 'b HALF OF A PAIR\n', 'b half')

    const result = await updateMember(repo, FEATURE, a.path)

    expect(result.ok).toBe(true)
    // A advanced …
    expect(readFileSync(join(benchPath(), 'a.txt'), 'utf-8')).toBe('a v2\n')
    // … and B stayed exactly where it was pinned.
    const bAfter = result.workspace!.members.find((m) => m.branchName === b.branch)!
    expect(bAfter.pinnedSha).toBe(bPinBefore)
    expect(readFileSync(join(benchPath(), 'b.txt'), 'utf-8')).toBe('b v1\n')
  })

  it('Update all advances every enabled stale member in one rebuild', async () => {
    localBench()
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, b.path, b.branch)
    await assembleWorkspace(repo, FEATURE)

    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')
    commitIn(b.path, 'b.txt', 'b v2\n', 'b more')

    const result = await updateAllStale(repo, FEATURE)

    expect(result.ok).toBe(true)
    expect(readFileSync(join(benchPath(), 'a.txt'), 'utf-8')).toBe('a v2\n')
    expect(readFileSync(join(benchPath(), 'b.txt'), 'utf-8')).toBe('b v2\n')
  })

  // A disabled member was excluded deliberately; advancing its pin would
  // re-integrate newer work the moment it is re-enabled.
  it('Update all leaves disabled members pinned where they were', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await assembleWorkspace(repo, FEATURE)
    const pinBefore = listWorkspaces(repo)[0].members[0].pinnedSha
    setMemberEnabled(repo, FEATURE, a.path, false)
    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')

    const result = await updateAllStale(repo, FEATURE)

    expect(result.workspace!.members[0].pinnedSha).toBe(pinBefore)
  })
}, GIT_FIXTURE_TIMEOUT)

describe('staleness reporting', () => {
  it('marks a member behind once its committed content moves past the pin', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await assembleWorkspace(repo, FEATURE)
    expect((await refreshStaleness(repo, FEATURE))!.members[0].pin).toBe('current')

    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')

    expect((await refreshStaleness(repo, FEATURE))!.members[0].pin).toBe('behind')
  })

  it('does not rewrite the workspace file when nothing changed (poll-safe)', async () => {
    // refreshStaleness runs on a poll while the worktree panel is open. An
    // unconditional persist turned that poll into an endless stream of
    // identical file writes; the write must happen only when the evaluation
    // actually moved something.
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await assembleWorkspace(repo, FEATURE)
    await refreshStaleness(repo, FEATURE)

    const file = join(storeDir, '.ion', 'integration-workspaces.json')
    const before = statSync(file).mtimeMs
    await refreshStaleness(repo, FEATURE) // nothing moved
    expect(statSync(file).mtimeMs).toBe(before)

    commitIn(a.path, 'a.txt', 'a v2\n', 'a more') // now something moved
    await refreshStaleness(repo, FEATURE)
    expect(statSync(file).mtimeMs).toBeGreaterThan(before)
  })

  it('does not mark a member behind for uncommitted work', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await assembleWorkspace(repo, FEATURE)

    writeFileSync(join(a.path, 'a.txt'), 'uncommitted edit\n')

    expect((await refreshStaleness(repo, FEATURE))!.members[0].pin).toBe('current')
  })

  // Staleness owns the pin axis and nothing else. This used to require a guard
  // clause in a priority ladder ("never overwrite a conflict verdict"); now the
  // two facts live in different fields and cannot collide.
  it('keeps the conflict verdict AND reports the member moved on', async () => {
    localBench()
    const a = makeWorktree('a')
    const c = makeWorktree('c')
    // Force a collision on the same file.
    commitIn(a.path, 'shared.txt', 'from a\n', 'a shared')
    commitIn(c.path, 'shared.txt', 'from c\n', 'c shared')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, c.path, c.branch)
    const built = await assembleWorkspace(repo, FEATURE)
    expect(built.workspace!.members.find((m) => m.branchName === c.branch)!.merge).toBe('conflicted')

    commitIn(c.path, 'c.txt', 'c v2\n', 'c more')
    const refreshed = await refreshStaleness(repo, FEATURE)
    const member = refreshed!.members.find((m) => m.branchName === c.branch)!

    // BOTH facts survive. Under the collapsed enum the record held one word and
    // the other fact was gone -- the ladder preserved `conflicted` and silently
    // discarded the staleness.
    expect(member.merge).toBe('conflicted')
    expect(member.pin).toBe('behind')
  })

  // The information-loss bug the axis split exists to fix: an excluded member
  // that has also moved on. The old ladder reported only `excluded`, so
  // re-enabling it merged a stale pin with no warning anywhere.
  it('keeps reporting a behind pin on an EXCLUDED member', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await assembleWorkspace(repo, FEATURE)

    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')
    setMemberEnabled(repo, FEATURE, a.path, false)

    const refreshed = await refreshStaleness(repo, FEATURE)
    const member = refreshed!.members[0]

    expect(member.enabled).toBe(false)
    expect(member.pin).toBe('behind')
  })

  it('surfaces the stale pin when an excluded member is re-enabled', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await assembleWorkspace(repo, FEATURE)
    setMemberEnabled(repo, FEATURE, a.path, false)
    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')
    await refreshStaleness(repo, FEATURE)

    const reenabled = setMemberEnabled(repo, FEATURE, a.path, true)

    // The operator is told the pin is old BEFORE the next build merges it.
    expect(reenabled!.members[0].enabled).toBe(true)
    expect(reenabled!.members[0].pin).toBe('behind')
  })

  it('reports a member whose worktree is gone', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    git(repo, 'worktree', 'remove', '--force', a.path)

    expect((await refreshStaleness(repo, FEATURE))!.members[0].pin).toBe('gone')
  })

  it('keeps an empty pin empty until the member commits', async () => {
    localBench()
    // NOT makeWorktree: that helper commits, and a member enrolled with commits
    // already has a real contribution. This is the enrolled-before-first-commit
    // case, where saying `current` would claim content the bench does not hold.
    const path = join(root, 'fresh')
    const branch = 'wt/fresh'
    git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)

    await addMember(repo, FEATURE, path, branch)
    expect((await refreshStaleness(repo, FEATURE))!.members[0].pin).toBe('empty')

    commitIn(path, 'fresh.txt', 'first\n', 'fresh first')

    expect((await refreshStaleness(repo, FEATURE))!.members[0].pin).toBe('behind')
  })
})

describe('review verdicts', () => {
  it('records and clears a verdict on the current pin', async () => {
    localBench()
    const a = makeWorktree('a')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    await addMember(repo, FEATURE, a.path, a.branch)

    expect(setMemberReview(repo, FEATURE, a.path, 'good')!.members[0].review).toBe('good')
    expect(setMemberReview(repo, FEATURE, a.path, 'issue')!.members[0].review).toBe('issue')
    expect(setMemberReview(repo, FEATURE, a.path, null)!.members[0].review).toBeUndefined()
  })

  it('survives an Update that re-pins identical content', async () => {
    localBench()
    const a = makeWorktree('a')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    await addMember(repo, FEATURE, a.path, a.branch)
    setMemberReview(repo, FEATURE, a.path, 'issue')

    // Nothing new committed: the pin cannot move, so the verdict still applies
    // to exactly the contribution that was reviewed. `issue` is the verdict
    // that CAN be auto-cleared, so it is the one that pins the keep.
    const result = await updateMember(repo, FEATURE, a.path)

    expect(result.workspace!.members[0].review).toBe('issue')
  })

  it('keeps a good verdict when the pin advances', async () => {
    localBench()
    const a = makeWorktree('a')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    await addMember(repo, FEATURE, a.path, a.branch)
    setMemberReview(repo, FEATURE, a.path, 'good')

    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')
    const result = await updateMember(repo, FEATURE, a.path)

    // `good` records that the FEATURE was reviewed and works — a statement
    // that stays valid across pin advances. Only the operator changes it.
    expect(result.workspace!.members[0].review).toBe('good')
  })

  it('clears an issue verdict when the pin actually advances', async () => {
    localBench()
    const a = makeWorktree('a')
    commitIn(a.path, 'a.txt', 'a\n', 'a work')
    await addMember(repo, FEATURE, a.path, a.branch)
    setMemberReview(repo, FEATURE, a.path, 'issue')

    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')
    const result = await updateMember(repo, FEATURE, a.path)

    // `issue` describes a contribution, not a worktree. New content is a
    // clean slate for retesting; the operator re-flags it if the bug is
    // still there, or marks it good if the fix landed.
    expect(result.workspace!.members[0].review).toBeUndefined()
  })

  it('update-all clears only advanced issue verdicts, never good ones', async () => {
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
    setMemberReview(repo, FEATURE, a.path, 'issue')
    setMemberReview(repo, FEATURE, b.path, 'issue')
    setMemberReview(repo, FEATURE, c.path, 'good')

    // `a` and `c` move; `b` stays where it was reviewed.
    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')
    commitIn(c.path, 'c.txt', 'c v2\n', 'c more')
    const result = await updateAllStale(repo, FEATURE)

    const byBranch = (br: string) => result.workspace!.members.find((m) => m.branchName === br)!
    expect(byBranch(a.branch).review).toBeUndefined()
    expect(byBranch(b.branch).review).toBe('issue')
    expect(byBranch(c.branch).review).toBe('good')
  })
})

describe('merge order', () => {
  it('moves a member to a new position, and order is array order', async () => {
    localBench()
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const c = makeWorktree('c')
    for (const w of [a, b, c]) await addMember(repo, FEATURE, w.path, w.branch)

    const moved = setMemberOrder(repo, FEATURE, c.path, 0)

    expect(moved!.members.map((m) => m.branchName)).toEqual([c.branch, a.branch, b.branch])
  })

  it('clamps an overshooting target to the end of the list', async () => {
    localBench()
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, b.path, b.branch)

    const moved = setMemberOrder(repo, FEATURE, a.path, 99)

    expect(moved!.members.map((m) => m.branchName)).toEqual([b.branch, a.branch])
  })

  it('refuses to reorder a worktree that is not a member', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)

    expect(setMemberOrder(repo, FEATURE, '/not/a/member', 0)).toBeNull()
  })
}, GIT_FIXTURE_TIMEOUT)
