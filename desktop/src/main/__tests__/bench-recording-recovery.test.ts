/**
 * bench-recording-recovery — the WORKING targeted forget the bench-
 * verification recovery dialog uses.
 *
 * Pins the property the broken post-verify auto-forget never had: after
 * `forgetRecordingsForBranches`, the named member's conflict is genuinely
 * unresolved again -- a fresh merge attempt against it conflicts for real
 * rather than silently replaying the poisoned recording.
 *
 * Real repos, not mocks: the behaviour under test is git rerere's.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_RECOVERY || actual.homedir() }
})

import { assembleBench } from '../integration/bench-assemble'
import { forgetRecordingsForBranches } from '../integration/bench-recording-recovery'
import { captureContribution } from '../integration/bench-snapshot'
import { makeWorkspace, makeMember } from '../integration/bench-store'
import { GIT_FIXTURE_TIMEOUT } from '../../test/git-fixture-timeout'
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
  writeFileSync(join(dir, 'first.txt'), 'base first\n')
  writeFileSync(join(dir, 'second.txt'), 'base second\n')
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

function workspaceFor(members: IntegrationMember[] = []): IntegrationWorkspace {
  const ws = makeWorkspace(repo, 'main')
  return { ...ws, benchPath: join(root, 'bench'), benchBranch: 'ion/bench/test', members }
}

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

/** Resolve-once the way the desktop's resolve flow does, recording into rerere. */
function resolveOnceInBench(
  ws: IntegrationWorkspace,
  conflictedSha: string,
  path: string,
  resolution: string,
): void {
  git(ws.benchPath, 'config', 'rerere.enabled', 'true')
  git(ws.benchPath, 'config', 'rerere.autoUpdate', 'true')
  git(ws.benchPath, 'switch', '-C', ws.benchBranch, 'main', '--discard-changes')
  for (const m of ws.members) {
    if (m.pinnedSha === conflictedSha) break
    git(ws.benchPath, 'merge', '--no-ff', '-m', `ion-bench: ${m.branchName}`, m.pinnedSha)
  }
  try {
    git(ws.benchPath, 'merge', '--no-ff', '-m', 'resolve once', conflictedSha)
    throw new Error('expected the merge to conflict')
  } catch {
    writeFileSync(join(ws.benchPath, path), resolution)
    git(ws.benchPath, 'add', path)
    git(ws.benchPath, '-c', 'core.editor=true', 'merge', '--continue')
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-bench-recovery-')))
  process.env.ION_TEST_HOME_BENCH_RECOVERY = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_RECOVERY
  removeGitFixture(root)
})

describe('forgetRecordingsForBranches', () => {
  it('actually forgets: the branch conflicts for real on the next merge attempt', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])

    // First assembly fails atomically and enables rerere.
    const failed = await assembleBench(ws)
    expect(failed.workspace!.lastAssembly).toBe('failed')

    // Resolve once (poisoned on purpose): textually clean but not what a real
    // resolution would produce.
    resolveOnceInBench(ws, ws.members[1].pinnedSha, 'shared.txt', 'poisoned resolution\n')

    // Reassembling now replays the recording and "succeeds" mechanically.
    const replayed = await assembleBench(ws)
    expect(replayed.workspace!.lastAssembly).toBe('assembled')
    expect(replayed.workspace!.members.find((m) => m.branchName === 'wt/c')!.mergeResolution).toBe('replayed')

    // Forget the recording for wt/c specifically.
    const result = await forgetRecordingsForBranches(replayed.workspace!, ['wt/c'])
    expect(result.ok).toBe(true)
    expect(result.forgottenPaths).toContain('shared.txt')
    expect(result.branchesWithNothingToForget).toEqual([])

    // The proof: a fresh merge attempt against the SAME conflict now conflicts
    // for real -- the recording no longer replays it.
    git(ws.benchPath, 'switch', '-C', ws.benchBranch, 'main', '--discard-changes')
    git(ws.benchPath, 'merge', '--no-ff', '-m', 'prior', ws.members[0].pinnedSha)
    expect(() => git(ws.benchPath, 'merge', '--no-ff', '-m', 'conflict again', ws.members[1].pinnedSha)).toThrow()
    expect(git(ws.benchPath, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('shared.txt')
  })

  it('forgets one member while an unrelated recording still replays', async () => {
    const a = makeWorktree('a', 'first.txt', 'from a\n')
    const b = makeWorktree('b', 'first.txt', 'from b\n')
    const c = makeWorktree('c', 'second.txt', 'from c\n')
    const d = makeWorktree('d', 'second.txt', 'from d\n')
    const ws = workspaceFor([await enroll(a), await enroll(b), await enroll(c), await enroll(d)])

    // Record the first conflict, then a later independent conflict. The second
    // resolve starts from the first recording's replayed state, just as a real
    // bench assembly does when several members collide in sequence.
    await assembleBench(ws)
    resolveOnceInBench(ws, ws.members[1].pinnedSha, 'first.txt', 'first resolution\n')
    // Continue from first resolved state to create independent later recording.
    git(ws.benchPath, 'merge', '--no-ff', '-m', 'second prior', ws.members[2].pinnedSha)
    expect(() => git(ws.benchPath, 'merge', '--no-ff', '-m', 'second resolve', ws.members[3].pinnedSha)).toThrow()
    writeFileSync(join(ws.benchPath, 'second.txt'), 'second resolution\n')
    git(ws.benchPath, 'add', 'second.txt')
    git(ws.benchPath, '-c', 'core.editor=true', 'merge', '--continue')
    const replayed = await assembleBench(ws)
    expect(replayed.workspace!.lastAssembly).toBe('assembled')

    const forgotten = await forgetRecordingsForBranches(replayed.workspace!, ['wt/b'])
    expect(forgotten.forgottenPaths).toEqual(['first.txt'])

    // The selected recording is gone: its same merge needs a real resolution.
    git(ws.benchPath, 'switch', '-C', ws.benchBranch, 'main', '--discard-changes')
    git(ws.benchPath, 'merge', '--no-ff', '-m', 'first prior', ws.members[0].pinnedSha)
    expect(() => git(ws.benchPath, 'merge', '--no-ff', '-m', 'first fresh', ws.members[1].pinnedSha)).toThrow()
    git(ws.benchPath, 'merge', '--abort')

    // Recreate only the known first resolution, then reach the later member.
    // Its merge completes by rerere without reopening, proving the targeted
    // forget left the unrelated second recording intact.
    git(ws.benchPath, 'switch', '-C', ws.benchBranch, 'main', '--discard-changes')
    git(ws.benchPath, 'merge', '--no-ff', '-m', 'first prior', ws.members[0].pinnedSha)
    try {
      git(ws.benchPath, 'merge', '--no-ff', '-m', 'first manual', ws.members[1].pinnedSha)
    } catch {
      writeFileSync(join(ws.benchPath, 'first.txt'), 'first resolution\n')
      git(ws.benchPath, 'add', 'first.txt')
      git(ws.benchPath, '-c', 'core.editor=true', 'merge', '--continue')
    }
    git(ws.benchPath, 'merge', '--no-ff', '-m', 'second prior', ws.members[2].pinnedSha)
    expect(() => git(ws.benchPath, 'merge', '--no-ff', '-m', 'second replay', ws.members[3].pinnedSha)).toThrow()
    // `git merge` retains its conflict exit status even when rerere staged the
    // answer. No write occurs here: `merge --continue` succeeds only because
    // the unrelated second recording survived the first member's deletion.
    git(ws.benchPath, '-c', 'core.editor=true', 'merge', '--continue')
  })

  it('reports nothing to forget for a branch that merges cleanly on replay', async () => {
    const a = makeWorktree('a')
    const ws = workspaceFor([await enroll(a)])
    const assembled = await assembleBench(ws)
    expect(assembled.workspace!.lastAssembly).toBe('assembled')

    const result = await forgetRecordingsForBranches(assembled.workspace!, ['wt/a'])
    expect(result.ok).toBe(true)
    expect(result.forgottenPaths).toEqual([])
    expect(result.branchesWithNothingToForget).toEqual(['wt/a'])
  })

  it('refuses for a branch name that is not an enrolled member', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])
    await assembleBench(ws)
    resolveOnceInBench(ws, ws.members[1].pinnedSha, 'shared.txt', 'poisoned resolution\n')
    const replayed = await assembleBench(ws)

    const result = await forgetRecordingsForBranches(replayed.workspace!, ['wt/does-not-exist'])
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('leaves ignored build output untouched across the recover-and-rebuild cycle', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])
    await assembleBench(ws)
    resolveOnceInBench(ws, ws.members[1].pinnedSha, 'shared.txt', 'poisoned resolution\n')
    const replayed = await assembleBench(ws)
    mkdirSync(join(ws.benchPath, 'node_modules'), { recursive: true })
    writeFileSync(join(ws.benchPath, 'node_modules', '.probe'), 'expensive build output\n')

    await forgetRecordingsForBranches(replayed.workspace!, ['wt/c'])

    expect(execFileSync('cat', [join(ws.benchPath, 'node_modules', '.probe')], { encoding: 'utf-8' }))
      .toBe('expensive build output\n')
  })
}, GIT_FIXTURE_TIMEOUT)
