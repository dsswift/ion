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
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'fs'
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
  updateMember, updateAllStale, rebuildWorkspace, refreshStaleness, listWorkspaces,
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
    await rebuildWorkspace(repo, FEATURE)
    const pinBefore = listWorkspaces(repo)[0].members[0].pinnedSha

    commitIn(a.path, 'a.txt', 'a v2 UNPINNED\n', 'a moves on')

    const result = await rebuildWorkspace(repo, FEATURE)

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
    await rebuildWorkspace(repo, FEATURE)
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
    await rebuildWorkspace(repo, FEATURE)

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
    await rebuildWorkspace(repo, FEATURE)
    const pinBefore = listWorkspaces(repo)[0].members[0].pinnedSha
    setMemberEnabled(repo, FEATURE, a.path, false)
    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')

    const result = await updateAllStale(repo, FEATURE)

    expect(result.workspace!.members[0].pinnedSha).toBe(pinBefore)
  })
}, GIT_FIXTURE_TIMEOUT)

describe('staleness reporting', () => {
  it('marks a member stale once its committed content moves past the pin', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await rebuildWorkspace(repo, FEATURE)
    expect((await refreshStaleness(repo, FEATURE))!.members[0].status).toBe('integrated')

    commitIn(a.path, 'a.txt', 'a v2\n', 'a more')

    expect((await refreshStaleness(repo, FEATURE))!.members[0].status).toBe('stale')
  })

  it('does not mark a member stale for uncommitted work', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    await rebuildWorkspace(repo, FEATURE)

    writeFileSync(join(a.path, 'a.txt'), 'uncommitted edit\n')

    expect((await refreshStaleness(repo, FEATURE))!.members[0].status).toBe('integrated')
  })

  // A conflicted member that also moved on is still conflicted; reporting it as
  // merely `stale` would send the operator to press Update expecting it to help.
  it('does not overwrite a conflict verdict with staleness', async () => {
    localBench()
    const a = makeWorktree('a')
    const c = makeWorktree('c')
    // Force a collision on the same file.
    commitIn(a.path, 'shared.txt', 'from a\n', 'a shared')
    commitIn(c.path, 'shared.txt', 'from c\n', 'c shared')
    await addMember(repo, FEATURE, a.path, a.branch)
    await addMember(repo, FEATURE, c.path, c.branch)
    const built = await rebuildWorkspace(repo, FEATURE)
    expect(built.workspace!.members.find((m) => m.branchName === c.branch)!.status).toBe('conflicted')

    commitIn(c.path, 'c.txt', 'c v2\n', 'c more')
    const refreshed = await refreshStaleness(repo, FEATURE)

    expect(refreshed!.members.find((m) => m.branchName === c.branch)!.status).toBe('conflicted')
  })

  it('reports a member whose worktree is gone as missing', async () => {
    localBench()
    const a = makeWorktree('a')
    await addMember(repo, FEATURE, a.path, a.branch)
    git(repo, 'worktree', 'remove', '--force', a.path)

    expect((await refreshStaleness(repo, FEATURE))!.members[0].status).toBe('missing')
  })
}, GIT_FIXTURE_TIMEOUT)
