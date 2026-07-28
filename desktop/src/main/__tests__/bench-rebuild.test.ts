/**
 * Bench rebuild + contribution capture — against REAL git repositories.
 *
 * These pin the properties the whole design rests on:
 *   - the bench is a PURE FUNCTION of (source tip, ordered pinned members), so
 *     rebuilding never accumulates commits;
 *   - rebuild merges PINS, never current tips, which is what makes manual
 *     integration real (the commit-pair guarantee);
 *   - a `live` capture never writes to the member worktree;
 *   - a conflicting member is skipped and reported, never fatal;
 *   - ignored build output survives a rebuild (no `clean -x`).
 *
 * Real repos rather than mocks: the behavior under test is git's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, statSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME into the fixture so bench/registry writes never touch the
// developer's real ~/.ion. Per-file env var: vitest runs test FILES
// concurrently in one process, so a shared name lets files clobber each other.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_REBUILD || actual.homedir() }
})

import { rebuildBench } from '../integration/bench-rebuild'
import { captureContribution, contributedTreeHash } from '../integration/bench-snapshot'
import { makeWorkspace, makeMember } from '../integration/bench-store'
import type { IntegrationWorkspace, IntegrationMember } from '../../shared/types'

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
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  return dir
}

function makeWorktree(name: string, file = `${name}.txt`, content = `${name}\n`): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, 'main')
  writeFileSync(join(path, file), content)
  git(path, 'add', '-A')
  git(path, 'commit', '-m', `${name} work`)
  return { path, branch }
}

/** Build a workspace whose bench lives inside the test root (not ~/.ion). */
function workspaceFor(members: IntegrationMember[] = []): IntegrationWorkspace {
  const ws = makeWorkspace(repo, 'main')
  return { ...ws, benchPath: join(root, 'bench'), benchBranch: 'ion/bench/test', members }
}

/** Enroll a worktree, pinning it at its committed contribution. */
async function enroll(wt: { path: string; branch: string }): Promise<IntegrationMember> {
  const contribution = await captureContribution(wt.path, 'main')
  return makeMember({
    worktreePath: wt.path,
    branchName: wt.branch,
    pinnedSha: contribution.sha,
    pinnedTreeHash: contribution.treeHash,
    pinnedBaseSha: contribution.baseSha,
  })
}

/** Merge commits on the bench branch above the source tip. */
function benchMergeCount(benchPath: string): number {
  const out = git(benchPath, 'log', '--merges', '--format=%H', 'main..HEAD').trim()
  return out ? out.split('\n').length : 0
}

beforeEach(() => {
  // realpath: macOS /var is a symlink to /private/var and git reports the
  // resolved form.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-bench-')))
  process.env.ION_TEST_HOME_BENCH_REBUILD = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_REBUILD
  rmSync(root, { recursive: true, force: true })
})

describe('rebuildBench — pure function, no accumulation', () => {
  it('produces exactly one merge commit per member, and rebuilding again does not add more', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])

    const first = await rebuildBench(ws)
    expect(first.ok).toBe(true)
    expect(benchMergeCount(ws.benchPath)).toBe(2)

    // Rebuilding the same set is idempotent in content AND in commit count.
    const second = await rebuildBench(first.workspace!)
    expect(second.ok).toBe(true)
    expect(benchMergeCount(ws.benchPath)).toBe(2)
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(true)
  })

  it('removing a member subtracts its content and its merge commit', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await rebuildBench(ws)).workspace!

    const withoutB = { ...built, members: built.members.filter((m) => m.branchName !== 'wt/b') }
    const result = await rebuildBench(withoutB)

    expect(result.ok).toBe(true)
    expect(benchMergeCount(ws.benchPath)).toBe(1)
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(false)
  })

  it('updating a member replaces its merge instead of stacking a new one', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await rebuildBench(ws)).workspace!
    expect(benchMergeCount(ws.benchPath)).toBe(2)

    // A does more work and its pin is advanced (an explicit Update).
    writeFileSync(join(a.path, 'a2.txt'), 'more a\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a more work')
    const advanced = await enroll(a)
    const updated = {
      ...built,
      members: built.members.map((m) => (m.branchName === 'wt/a' ? { ...m, ...advanced } : m)),
    }

    const result = await rebuildBench(updated)

    expect(result.ok).toBe(true)
    // Still exactly one merge per member — nothing stacked.
    expect(benchMergeCount(ws.benchPath)).toBe(2)
    expect(existsSync(join(ws.benchPath, 'a2.txt'))).toBe(true)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(true)
  })

  it('excludes a disabled member without removing it from the list', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await rebuildBench(ws)).workspace!

    const disabled = {
      ...built,
      members: built.members.map((m) => (m.branchName === 'wt/b' ? { ...m, enabled: false } : m)),
    }
    const result = await rebuildBench(disabled)

    expect(result.ok).toBe(true)
    expect(benchMergeCount(ws.benchPath)).toBe(1)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(false)
    expect(result.workspace!.members).toHaveLength(2)
    expect(result.workspace!.members.find((m) => m.branchName === 'wt/b')!.status).toBe('excluded')
  })
})

describe('rebuildBench — pins, not tips (the commit-pair guarantee)', () => {
  // THE regression test for the whole manual-integration design. A rebuild
  // triggered to pick up member A must not drag in member B's half-finished
  // two-commit change.
  it('merges each member at its pinned contribution, not its current tip', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await rebuildBench(ws)).workspace!

    // B is mid-way through a two-commit change: commit 1 of 2 landed.
    writeFileSync(join(b.path, 'b-half.txt'), 'half of a pair\n')
    git(b.path, 'add', '-A')
    git(b.path, 'commit', '-m', 'b: first half of a pair')

    // A is genuinely ready; only A's pin is advanced.
    writeFileSync(join(a.path, 'a2.txt'), 'a ready\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a ready')
    const advancedA = await enroll(a)
    const updated = {
      ...built,
      members: built.members.map((m) => (m.branchName === 'wt/a' ? { ...m, ...advancedA } : m)),
    }

    const result = await rebuildBench(updated)

    expect(result.ok).toBe(true)
    // A's new work is in …
    expect(existsSync(join(ws.benchPath, 'a2.txt'))).toBe(true)
    // … and B's half-finished pair is NOT, even though its worktree moved.
    expect(existsSync(join(ws.benchPath, 'b-half.txt'))).toBe(false)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(true)
  })

  it('rebuild alone advances no pin and produces identical content when every member is stale', async () => {
    const a = makeWorktree('a')
    const ws = workspaceFor([await enroll(a)])
    const built = (await rebuildBench(ws)).workspace!
    const pinBefore = built.members[0].pinnedSha
    const headBefore = git(ws.benchPath, 'rev-parse', 'HEAD^{tree}').trim()

    // The worktree moves on, but nobody presses Update.
    writeFileSync(join(a.path, 'unlanded.txt'), 'not pinned\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a moves on')

    const result = await rebuildBench(built)

    expect(result.ok).toBe(true)
    expect(result.workspace!.members[0].pinnedSha).toBe(pinBefore)
    expect(git(ws.benchPath, 'rev-parse', 'HEAD^{tree}').trim()).toBe(headBefore)
    expect(existsSync(join(ws.benchPath, 'unlanded.txt'))).toBe(false)
  })
})

describe('rebuildBench — conflicts and missing members', () => {
  it('skips a conflicting member, reports its paths and who it collided with, and still builds the rest', async () => {
    // a and c both touch shared.txt; b is independent.
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const b = makeWorktree('b')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(b), await enroll(c)])

    const result = await rebuildBench(ws)

    expect(result.ok).toBe(true)
    const byBranch = Object.fromEntries(result.workspace!.members.map((m) => [m.branchName, m]))
    expect(byBranch['wt/a'].status).toBe('integrated')
    expect(byBranch['wt/b'].status).toBe('integrated')
    expect(byBranch['wt/c'].status).toBe('conflicted')
    expect(byBranch['wt/c'].conflictPaths).toContain('shared.txt')
    expect(byBranch['wt/c'].conflictsWith).toContain('wt/a')
    // The bench still built the non-conflicting members.
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(true)
    expect(readFileSync(join(ws.benchPath, 'shared.txt'), 'utf-8')).toBe('from a\n')
  })

  it('reports a member whose branch is gone as missing and builds without it', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])

    // Destroy b entirely: remove the worktree, delete the branch, and make the
    // pinned commit unreachable.
    const bPin = ws.members[1].pinnedSha
    git(repo, 'worktree', 'remove', '--force', b.path)
    git(repo, 'branch', '-D', 'wt/b')
    const broken = {
      ...ws,
      members: ws.members.map((m) => (m.branchName === 'wt/b' ? { ...m, pinnedSha: '0'.repeat(40) } : m)),
    }
    expect(bPin).toBeTruthy()

    const result = await rebuildBench(broken)

    expect(result.ok).toBe(true)
    expect(result.workspace!.members.find((m) => m.branchName === 'wt/b')!.status).toBe('missing')
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
  })
})

describe('rebuildBench — build output survives (no clean -x)', () => {
  it('leaves ignored files in the bench untouched across a rebuild', async () => {
    const a = makeWorktree('a')
    const ws = workspaceFor([await enroll(a)])
    await rebuildBench(ws)

    // Simulate an incremental build artifact in an ignored directory.
    mkdirSync(join(ws.benchPath, 'node_modules'), { recursive: true })
    writeFileSync(join(ws.benchPath, 'node_modules', '.probe'), 'expensive build output\n')

    const b = makeWorktree('b')
    const withB = { ...ws, members: [...ws.members, await enroll(b)] }
    const result = await rebuildBench(withB)

    expect(result.ok).toBe(true)
    expect(existsSync(join(ws.benchPath, 'node_modules', '.probe'))).toBe(true)
    expect(readFileSync(join(ws.benchPath, 'node_modules', '.probe'), 'utf-8')).toBe('expensive build output\n')
  })
})

describe('rebuildBench — self-healing', () => {
  it('recreates a bench worktree that was deleted outside Ion', async () => {
    const a = makeWorktree('a')
    const ws = workspaceFor([await enroll(a)])
    await rebuildBench(ws)
    expect(existsSync(ws.benchPath)).toBe(true)

    rmSync(ws.benchPath, { recursive: true, force: true })

    const result = await rebuildBench(ws)

    expect(result.ok).toBe(true)
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
  })
})

describe('captureContribution — committed work only', () => {
  // The hard rule: uncommitted work cannot be integrated. A bench built from a
  // half-saved working tree would represent a state that exists nowhere in
  // history — unreproducible, unreviewable, unlandable.
  // Covers BOTH shapes of uncommitted work. An untracked new file and a
  // modification to an already-tracked file behave differently in git (several
  // plumbing commands, `stash create` among them, silently ignore untracked
  // files), so a test that only creates a new file would pass against an
  // implementation that leaks tracked modifications into the bench.
  it('excludes uncommitted work from the bench — untracked files and tracked modifications', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'untracked.txt'), 'never committed\n')
    // base.txt is tracked and committed; modify it without committing.
    writeFileSync(join(a.path, 'base.txt'), 'MODIFIED but not committed\n')
    const ws = workspaceFor([await enroll(a)])

    const result = await rebuildBench(ws)

    expect(result.ok).toBe(true)
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
    // The untracked file never appears …
    expect(existsSync(join(ws.benchPath, 'untracked.txt'))).toBe(false)
    // … and the tracked file still holds its COMMITTED content.
    expect(readFileSync(join(ws.benchPath, 'base.txt'), 'utf-8')).toBe('base\n')
  })

  it('integrates the work once it is committed', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'later.txt'), 'staged and committed\n')
    const ws = workspaceFor([await enroll(a)])
    await rebuildBench(ws)
    expect(existsSync(join(ws.benchPath, 'later.txt'))).toBe(false)

    // Commit it, advance the pin (an explicit Update), rebuild.
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a: commit the rest')
    const advanced = await enroll(a)
    const updated = { ...ws, members: [{ ...ws.members[0], ...advanced }] }

    const result = await rebuildBench(updated)

    expect(result.ok).toBe(true)
    expect(existsSync(join(ws.benchPath, 'later.txt'))).toBe(true)
  })

  // Capture is read-only. Nothing about reading a member's contribution may
  // disturb the agent still working in that worktree.
  it('never writes the member index, HEAD, branch ref, or reflog', async () => {
    const a = makeWorktree('a')
    writeFileSync(join(a.path, 'uncommitted.txt'), 'in progress\n')

    const headBefore = git(a.path, 'rev-parse', 'HEAD').trim()
    const refBefore = git(a.path, 'rev-parse', 'wt/a').trim()
    const reflogBefore = git(a.path, 'reflog', 'show', 'wt/a')
    const statusBefore = git(a.path, 'status', '--porcelain')

    // The index-mtime assertion must bracket ONLY the capture: `git status`
    // opportunistically refreshes the index stat cache, so any git command
    // between the two stat() calls would bump the mtime by itself and the
    // assertion would be measuring the test rather than the product.
    const indexPath = join(repo, '.git', 'worktrees', 'a', 'index')
    const indexMtimeBefore = statSync(indexPath).mtimeMs
    const contribution = await captureContribution(a.path, 'main')
    const indexMtimeAfter = statSync(indexPath).mtimeMs

    expect(contribution.sha).toBe(headBefore)
    expect(indexMtimeAfter).toBe(indexMtimeBefore)
    expect(git(a.path, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(git(a.path, 'rev-parse', 'wt/a').trim()).toBe(refBefore)
    expect(git(a.path, 'reflog', 'show', 'wt/a')).toBe(reflogBefore)
    // The uncommitted file is still uncommitted and still unstaged.
    expect(git(a.path, 'status', '--porcelain')).toBe(statusBefore)
  })

  it('never lets ignored build output into the bench', async () => {
    const a = makeWorktree('a')
    mkdirSync(join(a.path, 'node_modules'), { recursive: true })
    writeFileSync(join(a.path, 'node_modules', 'junk.txt'), 'should not be benched\n')
    const ws = workspaceFor([await enroll(a)])

    const result = await rebuildBench(ws)

    expect(result.ok).toBe(true)
    expect(existsSync(join(ws.benchPath, 'node_modules', 'junk.txt'))).toBe(false)
  })
})

describe('contributedTreeHash — staleness identity', () => {
  it('is unchanged by an amend that produces an identical tree', async () => {
    const a = makeWorktree('a')
    const member = await enroll(a)

    // Amend: new sha, same tree.
    const shaBefore = git(a.path, 'rev-parse', 'HEAD').trim()
    git(a.path, 'commit', '--amend', '-m', 'a work (reworded)')
    const shaAfter = git(a.path, 'rev-parse', 'HEAD').trim()
    expect(shaAfter).not.toBe(shaBefore)

    const current = await contributedTreeHash(member)

    // A sha-driven implementation would call this stale. A tree-driven one
    // correctly reports no content change.
    expect(current).toBe(member.pinnedTreeHash)
  })

  it('changes when a commit adds content', async () => {
    const a = makeWorktree('a')
    const member = await enroll(a)

    writeFileSync(join(a.path, 'a2.txt'), 'new work\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a2')

    expect(await contributedTreeHash(member)).not.toBe(member.pinnedTreeHash)
  })

  // An uncommitted edit is not something the operator could integrate, so it
  // must not mark the member stale — a stale badge that no Update can clear
  // would be a lie.
  it('is unchanged by an uncommitted edit (untracked or tracked)', async () => {
    const a = makeWorktree('a')
    const member = await enroll(a)

    writeFileSync(join(a.path, 'scratch.txt'), 'uncommitted\n')
    expect(await contributedTreeHash(member)).toBe(member.pinnedTreeHash)

    writeFileSync(join(a.path, 'base.txt'), 'MODIFIED but not committed\n')
    expect(await contributedTreeHash(member)).toBe(member.pinnedTreeHash)
  })

  it('reports null when the worktree is gone', async () => {
    const a = makeWorktree('a')
    const member = await enroll(a)
    git(repo, 'worktree', 'remove', '--force', a.path)

    expect(await contributedTreeHash(member)).toBeNull()
  })
})
