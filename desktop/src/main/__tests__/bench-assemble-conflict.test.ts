/**
 * Bench assembly conflict behaviour — atomicity, attribution, and rerere.
 *
 * Split from bench-assemble.test.ts, which reached the test file-size cap, at
 * the natural seam: everything here is about what happens when a member's
 * pinned contribution will NOT merge. The properties pinned:
 *   - a conflict fails the WHOLE assembly (bench wiped empty, others unbuilt,
 *     failure recorded) — never a silent partial bench;
 *   - collision attribution reads each prior member's contribution RANGE,
 *     never its tip commit (the live defect that reported no collider);
 *   - an open resolve-once merge refuses the assembly with a typed refusal;
 *   - a resolution recorded once (git rerere) replays on every later assembly
 *     and stops replaying when the conflicting lines genuinely change.
 *
 * Real repos rather than mocks: the behaviour under test is git's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME into the fixture so bench/registry writes never touch the
// developer's real ~/.ion. Per-file env var: vitest runs test FILES
// concurrently in one process, so a shared name lets files clobber each other.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_CONFLICT || actual.homedir() }
})

import { assembleBench } from '../integration/bench-assemble'
import { captureContribution } from '../integration/bench-snapshot'
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
  const contribution = await captureContribution(wt.path, 'main', wt.branch)
  return makeMember({
    worktreePath: wt.path,
    branchName: wt.branch,
    pinnedSha: contribution.sha,
    pinnedTreeHash: contribution.treeHash,
    pinnedBaseSha: contribution.baseSha,
  })
}

beforeEach(() => {
  // realpath: macOS /var is a symlink to /private/var and git reports the
  // resolved form.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-bench-conflict-')))
  process.env.ION_TEST_HOME_BENCH_CONFLICT = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_CONFLICT
  rmSync(root, { recursive: true, force: true })
})

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
})

describe('assembleBench — refuses while a resolution merge is open', () => {
  // The live defect this pins: AI Assisted closed the ConflictsDialog, the
  // close handler reassembled, and the assembly's `switch -C` ran against the
  // bench whose merge the resolve-once flow had DELIBERATELY left open for
  // the AI to resolve. Git refused ("cannot switch branch while merging") but
  // that surfaced as a raw machinery error. The assembly must refuse first,
  // typed, with the actionable reason — and must not touch the merge.
  it('returns a typed refusal and leaves the in-progress merge untouched', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])
    await assembleBench(ws) // fails atomically, bench exists

    // Re-create the resolve-once state: merge left in progress.
    git(ws.benchPath, 'switch', '-C', 'ion/bench/test', 'main', '--discard-changes')
    git(ws.benchPath, 'merge', '--no-ff', '-m', 'prior', ws.members[0].pinnedSha)
    try {
      git(ws.benchPath, 'merge', '--no-ff', '-m', 'conflicted', ws.members[1].pinnedSha)
      throw new Error('expected the merge to conflict')
    } catch { /* in progress */ }

    const result = await assembleBench(ws)

    expect(result.ok).toBe(false)
    expect(result.refusal).toBe('resolution-in-progress')
    // The merge is still open: unmerged paths survive the refused assembly.
    expect(git(ws.benchPath, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('shared.txt')
  })
})

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

  it('rejects and forgets a replay whose recorded postimage contains conflict markers', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])

    await assembleBench(ws)
    const poisoned = '<<<<<<< HEAD\nfrom a\n=======\nfrom c\n>>>>>>> wt/c\n'
    resolveOnceInBench(ws, ws.members[1].pinnedSha, poisoned)

    const result = await assembleBench(ws)

    expect(result.workspace!.lastAssembly).toBe('failed')
    expect(result.workspace!.members.find((m) => m.branchName === 'wt/c')!.merge).toBe('conflicted')
    expect(existsSync(join(ws.benchPath, 'shared.txt'))).toBe(false)

    // Recording was forgotten while merge context still existed. Recreating
    // same conflict exposes real unmerged state instead of replaying poison.
    git(ws.benchPath, 'switch', '-C', ws.benchBranch, 'main', '--discard-changes')
    git(ws.benchPath, 'merge', '--no-ff', '-m', 'prior', ws.members[0].pinnedSha)
    expect(() => git(ws.benchPath, 'merge', '--no-ff', '-m', 'conflict again', ws.members[1].pinnedSha)).toThrow()
    expect(git(ws.benchPath, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('shared.txt')
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
