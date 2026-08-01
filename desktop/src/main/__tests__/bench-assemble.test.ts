/**
 * Bench assembly + contribution capture — against REAL git repositories.
 *
 * These pin the properties the whole design rests on:
 *   - the bench is a PURE FUNCTION of (source tip, ordered pinned members), so
 *     reassembling never accumulates commits;
 *   - assembly merges PINS, never current tips, which is what makes manual
 *     integration real (the commit-pair guarantee);
 *   - a `live` capture never writes to the member worktree;
 *   - a conflicting member is skipped and reported, never fatal;
 *   - ignored build output survives an assembly (no `clean -x`).
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
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_ASSEMBLE || actual.homedir() }
})

import { assembleBench } from '../integration/bench-assemble'
import { captureContribution, contributedTreeHash } from '../integration/bench-snapshot'
import { makeWorkspace, makeMember } from '../integration/bench-store'
import type { IntegrationWorkspace, IntegrationMember } from '../../shared/types'
import { GIT_FIXTURE_TIMEOUT } from '../../test/git-fixture-timeout'

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
  const contribution = await captureContribution(wt.path, 'main', wt.branch)
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
  process.env.ION_TEST_HOME_BENCH_ASSEMBLE = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_ASSEMBLE
  rmSync(root, { recursive: true, force: true })
})

describe('assembleBench — pure function, no accumulation', () => {
  it('produces exactly one merge commit per member, and assembling again does not add more', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])

    const first = await assembleBench(ws)
    expect(first.ok).toBe(true)
    expect(benchMergeCount(ws.benchPath)).toBe(2)

    // Reassembling the same set is idempotent in content AND in commit count.
    const second = await assembleBench(first.workspace!)
    expect(second.ok).toBe(true)
    expect(benchMergeCount(ws.benchPath)).toBe(2)
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(true)
  })

  it('removing a member subtracts its content and its merge commit', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await assembleBench(ws)).workspace!

    const withoutB = { ...built, members: built.members.filter((m) => m.branchName !== 'wt/b') }
    const result = await assembleBench(withoutB)

    expect(result.ok).toBe(true)
    expect(benchMergeCount(ws.benchPath)).toBe(1)
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(false)
  })

  it('updating a member replaces its merge instead of stacking a new one', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await assembleBench(ws)).workspace!
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

    const result = await assembleBench(updated)

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
    const built = (await assembleBench(ws)).workspace!

    const disabled = {
      ...built,
      members: built.members.map((m) => (m.branchName === 'wt/b' ? { ...m, enabled: false } : m)),
    }
    const result = await assembleBench(disabled)

    expect(result.ok).toBe(true)
    expect(benchMergeCount(ws.benchPath)).toBe(1)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(false)
    expect(result.workspace!.members).toHaveLength(2)
    const excluded = result.workspace!.members.find((m) => m.branchName === 'wt/b')!
    // Only the merge axis records the exclusion. The pin keeps saying how fresh
    // the contribution is, which is what a re-enable needs to know.
    expect(excluded.merge).toBe('skipped')
    expect(excluded.enabled).toBe(false)
  })
}, GIT_FIXTURE_TIMEOUT)

describe('assembleBench — pins, not tips (the commit-pair guarantee)', () => {
  // THE regression test for the whole manual-integration design. An assembly
  // triggered to pick up member A must not drag in member B's half-finished
  // two-commit change.
  it('merges each member at its pinned contribution, not its current tip', async () => {
    const a = makeWorktree('a')
    const b = makeWorktree('b')
    const ws = workspaceFor([await enroll(a), await enroll(b)])
    const built = (await assembleBench(ws)).workspace!

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

    const result = await assembleBench(updated)

    expect(result.ok).toBe(true)
    // A's new work is in …
    expect(existsSync(join(ws.benchPath, 'a2.txt'))).toBe(true)
    // … and B's half-finished pair is NOT, even though its worktree moved.
    expect(existsSync(join(ws.benchPath, 'b-half.txt'))).toBe(false)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(true)
  })

  it('assembly alone advances no pin and produces identical content when every member is stale', async () => {
    const a = makeWorktree('a')
    const ws = workspaceFor([await enroll(a)])
    const built = (await assembleBench(ws)).workspace!
    const pinBefore = built.members[0].pinnedSha
    const headBefore = git(ws.benchPath, 'rev-parse', 'HEAD^{tree}').trim()

    // The worktree moves on, but nobody presses Update.
    writeFileSync(join(a.path, 'unlanded.txt'), 'not pinned\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a moves on')

    const result = await assembleBench(built)

    expect(result.ok).toBe(true)
    expect(result.workspace!.members[0].pinnedSha).toBe(pinBefore)
    expect(git(ws.benchPath, 'rev-parse', 'HEAD^{tree}').trim()).toBe(headBefore)
    expect(existsSync(join(ws.benchPath, 'unlanded.txt'))).toBe(false)
  })
}, GIT_FIXTURE_TIMEOUT)

describe('assembleBench — atomic conflicts and missing members', () => {
  it('fails the whole assembly on a conflict: bench wiped empty, others unbuilt, failure recorded', async () => {
    // a and c both touch shared.txt; b is independent and merged BEFORE the
    // conflict is hit.
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const b = makeWorktree('b')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(b), await enroll(c)])

    // An ignored build artifact must survive the atomic wipe (no clean -x):
    // seed it via a first assembly of a alone, then add the conflicting set.
    await assembleBench({ ...ws, members: [ws.members[0]] })
    mkdirSync(join(ws.benchPath, 'node_modules'), { recursive: true })
    writeFileSync(join(ws.benchPath, 'node_modules', '.probe'), 'expensive build output\n')

    const result = await assembleBench(ws)

    expect(result.ok).toBe(true)
    const workspace = result.workspace!
    expect(workspace.lastAssembly).toBe('failed')
    expect(workspace.lastAssemblyError).toContain('wt/c')

    const byBranch = Object.fromEntries(workspace.members.map((m) => [m.branchName, m]))
    expect(byBranch['wt/c'].merge).toBe('conflicted')
    expect(byBranch['wt/c'].conflictPaths).toContain('shared.txt')
    expect(byBranch['wt/c'].conflictsWith).toContain('wt/a')
    // Members that merged before the conflict are NOT in the bench after the
    // wipe, so claiming `merged` would describe a tree that no longer exists.
    expect(byBranch['wt/a'].merge).toBe('unbuilt')
    expect(byBranch['wt/b'].merge).toBe('unbuilt')

    // The bench presents NOTHING: tracked files gone, no member content.
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(false)
    expect(existsSync(join(ws.benchPath, 'b.txt'))).toBe(false)
    expect(existsSync(join(ws.benchPath, 'shared.txt'))).toBe(false)
    expect(existsSync(join(ws.benchPath, 'base.txt'))).toBe(false)
    // … but ignored build output survives, exactly like a normal assembly.
    expect(readFileSync(join(ws.benchPath, 'node_modules', '.probe'), 'utf-8')).toBe('expensive build output\n')
  })

  // THE regression test for tip-only attribution. The prior member's TIP
  // commit touches only an unrelated file; the conflicting path was changed by
  // an EARLIER commit in its range. `git show <tip>` misses it and reports no
  // collider — the live defect: conflictsWith came back empty and the UI could
  // name no counterpart. Range attribution (base..pin) finds it.
  it('attributes a collision through the prior member\'s whole range, not its tip commit', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    // Second commit: a's TIP no longer names shared.txt.
    writeFileSync(join(a.path, 'a-docs.txt'), 'unrelated docs change\n')
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a: unrelated tip commit')

    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])

    const result = await assembleBench(ws)

    expect(result.ok).toBe(true)
    const byBranch = Object.fromEntries(result.workspace!.members.map((m) => [m.branchName, m]))
    expect(byBranch['wt/c'].merge).toBe('conflicted')
    expect(byBranch['wt/c'].conflictPaths).toContain('shared.txt')
    expect(byBranch['wt/c'].conflictsWith).toContain('wt/a')
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

    const result = await assembleBench(broken)

    expect(result.ok).toBe(true)
    expect(result.workspace!.members.find((m) => m.branchName === 'wt/b')!.pin).toBe('gone')
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
  })
}, GIT_FIXTURE_TIMEOUT)

describe('assembleBench — rerere resolve once, replay forever', () => {
  /**
   * Resolve the conflict the way the resolve-once flow does: re-create the
   * merge in the bench, write the resolution, commit — which records it in the
   * MAIN repo's rr-cache (shared by the linked bench worktree).
   */
  function resolveOnceInBench(ws: IntegrationWorkspace, conflictedSha: string, resolution: string): void {
    git(ws.benchPath, 'config', 'rerere.enabled', 'true')
    git(ws.benchPath, 'config', 'rerere.autoUpdate', 'true')
    git(ws.benchPath, 'switch', '-C', ws.benchBranch, 'main', '--discard-changes')
    // Recreate the same context the assembly builds: prior members first.
    for (const m of ws.members) {
      if (m.pinnedSha === conflictedSha) break
      git(ws.benchPath, 'merge', '--no-ff', '-m', `ion-bench: ${m.branchName}`, m.pinnedSha)
    }
    try {
      git(ws.benchPath, 'merge', '--no-ff', '-m', 'resolve once', conflictedSha)
      throw new Error('expected the merge to conflict')
    } catch {
      // In progress. Resolve and commit — this is what records the resolution.
      writeFileSync(join(ws.benchPath, 'shared.txt'), resolution)
      git(ws.benchPath, 'add', 'shared.txt')
      git(ws.benchPath, '-c', 'core.editor=true', 'merge', '--continue')
    }
  }

  it('replays a recorded resolution on the next assembly and reports it as replayed', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])

    // First assembly fails atomically (and enables rerere in the repo).
    const failed = await assembleBench(ws)
    expect(failed.workspace!.lastAssembly).toBe('failed')

    // Resolve ONCE, the way the resolve-once flow does.
    resolveOnceInBench(ws, ws.members[1].pinnedSha, 'from a and c, resolved\n')

    // Reassemble: the recording replays, the assembly completes, and the
    // member says so — a replayed resolution is not a clean merge.
    const replayed = await assembleBench(ws)
    expect(replayed.ok).toBe(true)
    expect(replayed.workspace!.lastAssembly).toBe('assembled')
    const member = replayed.workspace!.members.find((m) => m.branchName === 'wt/c')!
    expect(member.merge).toBe('merged')
    expect(member.mergeResolution).toBe('replayed')
    expect(readFileSync(join(ws.benchPath, 'shared.txt'), 'utf-8')).toBe('from a and c, resolved\n')

    // And it keeps replaying: assembly is still a pure function.
    const again = await assembleBench(replayed.workspace!)
    expect(again.workspace!.lastAssembly).toBe('assembled')
    expect(again.workspace!.members.find((m) => m.branchName === 'wt/c')!.mergeResolution).toBe('replayed')
  })

  it('stops replaying when the conflicting lines genuinely change, and honestly conflicts again', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])

    await assembleBench(ws)
    resolveOnceInBench(ws, ws.members[1].pinnedSha, 'from a and c, resolved\n')
    expect((await assembleBench(ws)).workspace!.lastAssembly).toBe('assembled')

    // c rewrites the conflicted lines: the recording's preimage no longer
    // matches, so replaying it would be wrong — and does not happen.
    writeFileSync(join(c.path, 'shared.txt'), 'from c, take two\n')
    git(c.path, 'add', '-A')
    git(c.path, 'commit', '-m', 'c: rework the conflicted region')
    const advanced = await enroll(c)
    const updated = {
      ...ws,
      members: ws.members.map((m) => (m.branchName === 'wt/c' ? { ...m, ...advanced } : m)),
    }

    const result = await assembleBench(updated)
    expect(result.workspace!.lastAssembly).toBe('failed')
    const member = result.workspace!.members.find((m) => m.branchName === 'wt/c')!
    expect(member.merge).toBe('conflicted')
    expect(member.mergeResolution).toBeUndefined()
  })
})

describe('assembleBench — build output survives (no clean -x)', () => {
  it('leaves ignored files in the bench untouched across an assembly', async () => {
    const a = makeWorktree('a')
    const ws = workspaceFor([await enroll(a)])
    await assembleBench(ws)

    // Simulate an incremental build artifact in an ignored directory.
    mkdirSync(join(ws.benchPath, 'node_modules'), { recursive: true })
    writeFileSync(join(ws.benchPath, 'node_modules', '.probe'), 'expensive build output\n')

    const b = makeWorktree('b')
    const withB = { ...ws, members: [...ws.members, await enroll(b)] }
    const result = await assembleBench(withB)

    expect(result.ok).toBe(true)
    expect(existsSync(join(ws.benchPath, 'node_modules', '.probe'))).toBe(true)
    expect(readFileSync(join(ws.benchPath, 'node_modules', '.probe'), 'utf-8')).toBe('expensive build output\n')
  })
}, GIT_FIXTURE_TIMEOUT)

describe('assembleBench — self-healing', () => {
  it('recreates a bench worktree that was deleted outside Ion', async () => {
    const a = makeWorktree('a')
    const ws = workspaceFor([await enroll(a)])
    await assembleBench(ws)
    expect(existsSync(ws.benchPath)).toBe(true)

    rmSync(ws.benchPath, { recursive: true, force: true })

    const result = await assembleBench(ws)

    expect(result.ok).toBe(true)
    expect(existsSync(join(ws.benchPath, 'a.txt'))).toBe(true)
  })
}, GIT_FIXTURE_TIMEOUT)

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

    const result = await assembleBench(ws)

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
    await assembleBench(ws)
    expect(existsSync(join(ws.benchPath, 'later.txt'))).toBe(false)

    // Commit it, advance the pin (an explicit Update), reassemble.
    git(a.path, 'add', '-A')
    git(a.path, 'commit', '-m', 'a: commit the rest')
    const advanced = await enroll(a)
    const updated = { ...ws, members: [{ ...ws.members[0], ...advanced }] }

    const result = await assembleBench(updated)

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
    const contribution = await captureContribution(a.path, 'main', a.branch)
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

    const result = await assembleBench(ws)

    expect(result.ok).toBe(true)
    expect(existsSync(join(ws.benchPath, 'node_modules', 'junk.txt'))).toBe(false)
  })
}, GIT_FIXTURE_TIMEOUT)

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
}, GIT_FIXTURE_TIMEOUT)
