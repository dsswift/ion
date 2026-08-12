/**
 * Bench assembly — untracked-leftover self-heal, and rerere path scoping.
 *
 * Split from bench-assemble-conflict.test.ts (file-size cap) at the seam
 * between "what happens when a merge genuinely conflicts" (that file) and
 * "what happens when a merge fails for a DIFFERENT reason, or when rerere's
 * own bookkeeping needs to be scoped precisely" (here). Real repos, not
 * mocks: the behaviour under test is git's own abort/clean/rerere mechanics.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME into the fixture so bench/registry writes never touch the
// developer's real ~/.ion. Per-file env var: vitest runs test FILES
// concurrently in one process, so a shared name lets files clobber each other.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_UNTRACKED || actual.homedir() }
})

import { assembleBench } from '../integration/bench-assemble'
import { captureContribution } from '../integration/bench-snapshot'
import { makeWorkspace, makeMember } from '../integration/bench-store'
import { currentRererePaths, validateBenchResolution } from '../integration/bench-resolution-validation'
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-bench-untracked-')))
  process.env.ION_TEST_HOME_BENCH_UNTRACKED = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_UNTRACKED
  removeGitFixture(root)
})

/**
 * Untracked leftovers from an earlier failed assembly self-heal — the exact
 * incident this fix closes.
 *
 * Confirmed directly against real git (not inferred): `merge --abort` backs
 * out TRACKED merge state but does not delete an untracked, non-ignored file
 * that was already on disk before the merge was attempted — it survives at
 * exactly the path the next merge wants to write, and every later assembly
 * hits git's own "would be overwritten by merge" refusal at that path,
 * forever, because `--discard-changes` resets tracked files only. This is
 * the observed production loop: a bench stuck failing on a git error it
 * never even surfaced, since the merge fails with ZERO unmerged paths (it
 * never reached conflict state at all).
 */
describe('assembleBench — untracked leftovers self-heal on the next reset', () => {
  it('removes a stray untracked file at a path the incoming member wants to write, and assembles clean', async () => {
    const a = makeWorktree('a', 'a.txt', 'from a\n')
    const ws = workspaceFor([await enroll(a)])

    // Simulate the leftover an earlier failed assembly left behind: an
    // untracked, non-ignored file sitting at a path this member's branch
    // also wants to write, present BEFORE the merge is ever attempted —
    // exactly the shape confirmed to survive `merge --abort`.
    await assembleBench(ws)
    writeFileSync(join(ws.benchPath, 'a.txt'), 'PRE-EXISTING untracked leftover, not from this assembly\n')
    // Force the bench branch back to a state where a.txt is untracked, the
    // way an aborted merge leaves it: the tracked reset below re-derives
    // from source, then the leftover write above sits untracked at the path.
    execFileSync('git', ['switch', '-C', 'ion/bench/test', 'main', '--discard-changes'], { cwd: ws.benchPath })
    writeFileSync(join(ws.benchPath, 'a.txt'), 'PRE-EXISTING untracked leftover, not from this assembly\n')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: ws.benchPath, encoding: 'utf-8' }).trim())
      .toBe('?? a.txt')

    // RED before the fix: this assembly would fail with git's own
    // "would be overwritten by merge" error and ZERO unmerged paths, forever,
    // on every subsequent attempt — because nothing before `resetBenchToTree`
    // ever ran a clean step. After the fix: the leftover is removed as part
    // of the ordinary reset-to-tree step, before any merge is attempted.
    const result = await assembleBench(ws)

    expect(result.ok).toBe(true)
    expect(result.workspace!.lastAssembly).toBe('assembled')
    expect(readFileSync(join(ws.benchPath, 'a.txt'), 'utf-8')).toBe('from a\n')
  })

  // Proof the fix is precise (`-fd`, never `-x`): ignored build output must
  // survive the SAME reset step that now also cleans untracked leftovers.
  it('still leaves ignored build output untouched by the untracked-leftover cleanup', async () => {
    const a = makeWorktree('a')
    const ws = workspaceFor([await enroll(a)])
    await assembleBench(ws)
    mkdirSync(join(ws.benchPath, 'node_modules'), { recursive: true })
    writeFileSync(join(ws.benchPath, 'node_modules', '.probe'), 'expensive build output\n')
    // A genuine untracked leftover alongside the ignored directory.
    writeFileSync(join(ws.benchPath, 'stray-untracked.txt'), 'leftover debris\n')

    const result = await assembleBench(ws)

    expect(result.ok).toBe(true)
    expect(readFileSync(join(ws.benchPath, 'node_modules', '.probe'), 'utf-8')).toBe('expensive build output\n')
    expect(existsSync(join(ws.benchPath, 'stray-untracked.txt'))).toBe(false)
  })
})

/**
 * A merge failure that never reaches conflict state is a DIFFERENT failure
 * kind than a content conflict — classified `'obstructed'` by
 * `classifyMergeFailure` (bench-assemble-support.ts), with the actual git
 * error surfaced verbatim rather than the old bare fallback that silently
 * discarded it. See `bench-assemble-support.test.ts` for the direct unit
 * tests of the classification decision itself (zero unmerged paths →
 * `'obstructed'`, at least one → `'conflict'`) — self-healing (above) means
 * an untracked-obstruction failure can no longer reach the assembly loop's
 * own merge attempt under NORMAL operation, so the classification is pinned
 * at the seam where it is actually decided rather than forced through an
 * end-to-end path that the fix itself makes unreachable.
 *
 * Rerere path capture and staged-content validation are scoped to paths BOTH
 * sides of a merge independently changed since their common ancestor, not
 * every staged file in the whole merge.
 *
 * The confirmed production incident: a member's own branch had ~200+ files
 * across many commits, and only ONE genuinely conflicted with the base
 * branch — every other file was a clean two-way add the member's own commits
 * introduced. That shape produces a multi-hundred-line "checked invalid
 * rerere recording" log storm (one wasted no-op forget per unrelated file)
 * precisely because `rerere status` (and even the raw `.git/MERGE_RR`
 * record) go EMPTY once `rerere.autoUpdate` fully auto-stages the one real
 * conflict — confirmed directly, and matching the incident log exactly
 * (`rerere_status_paths: []`, `unmerged_count: 0`). The same shape creates a
 * false-positive risk for the whitespace/conflict-marker staged-content
 * check: an unrelated clean file the member's own commit legitimately added
 * can fail a check that has nothing to do with the actual conflict.
 *
 * Both are fixed by intersecting the staged/checked set with
 * `bothSidesChangedPaths` — paths BOTH `HEAD` and `MERGE_HEAD` independently
 * diverged from their merge base at, which a clean two-way add or edit can
 * never be part of by definition. This is NOT the same as scoping to the
 * incoming commit's own range (a first attempt at this fix, since discarded
 * after direct verification showed it doesn't narrow anything when the
 * clean files and the real conflict are both part of that same commit's own
 * range) — see `bothSidesChangedPaths`'s doc comment in
 * `bench-resolution-validation.ts` for the full reasoning.
 */
describe('bench rerere path capture — scoped to paths both sides changed', () => {
  it('captures only the genuinely conflicting path, never a clean file the same commit also introduced', async () => {
    git(repo, 'config', 'rerere.enabled', 'true')
    git(repo, 'config', 'rerere.autoUpdate', 'true')

    // Train a rerere recording for base.txt so the replay auto-stages fully
    // (rerere status/MERGE_RR going empty is what the real incident hit).
    git(repo, 'checkout', '-qb', 'trainer')
    writeFileSync(join(repo, 'base.txt'), 'trainer edit\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'trainer edits base.txt')
    git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'base.txt'), 'main edit\n')
    git(repo, 'commit', '-am', 'main edits base.txt')
    expect(() => git(repo, 'merge', '--no-ff', '-m', 'train', 'trainer')).toThrow()
    writeFileSync(join(repo, 'base.txt'), 'resolved\n')
    git(repo, 'add', 'base.txt')
    git(repo, 'commit', '-m', 'train')
    git(repo, 'branch', '-D', 'trainer')

    // Recreate the SAME base.txt conflict, alongside several clean files —
    // all in ONE commit, exactly like a real member's own large branch.
    git(repo, 'checkout', '-qb', 'member', 'main~1')
    writeFileSync(join(repo, 'base.txt'), 'trainer edit\n')
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(repo, `member_file_${i}.txt`), `member ${i}\n`)
    }
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'member: matches trained base.txt conflict + 5 clean files')
    git(repo, 'checkout', '-q', 'main')

    expect(() => git(repo, 'merge', '--no-ff', '-m', 'merge member', 'member')).toThrow()

    const captured = await currentRererePaths(repo)

    expect(captured.ok).toBe(true)
    if (captured.ok) {
      expect(captured.paths).toEqual(['base.txt'])
      // None of the member's own clean files leak into the capture — the
      // regression this closes.
      expect(captured.paths.some((p) => p.startsWith('member_file_'))).toBe(false)
    }
    // Resolve whatever the merge left unmerged (rerere may or may not have
    // fully auto-staged it, depending on the exact preimage match) so the
    // fixture ends in a clean, committed state.
    if (git(repo, 'diff', '--name-only', '--diff-filter=U').trim()) {
      writeFileSync(join(repo, 'base.txt'), 'resolved\n')
      git(repo, 'add', 'base.txt')
    }
    git(repo, 'commit', '--no-edit')
  })

  it('scopes the staged-content check so a clean file in the same commit as the conflict never fails validation of a different path', async () => {
    git(repo, 'config', 'rerere.enabled', 'true')
    git(repo, 'config', 'rerere.autoUpdate', 'true')

    git(repo, 'checkout', '-qb', 'member')
    writeFileSync(join(repo, 'base.txt'), 'member edit\n')
    // A clean file the SAME commit introduces, with legitimate trailing
    // whitespace — real content unrelated to the conflict.
    writeFileSync(join(repo, 'member_whitespace.txt'), 'trailing whitespace here   \n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'member: conflicting base.txt edit + clean file with trailing whitespace')
    git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'base.txt'), 'main conflicting edit\n')
    git(repo, 'commit', '-am', 'main: conflicts with member')

    expect(() => git(repo, 'merge', '--no-ff', '-m', 'merge member', 'member')).toThrow()
    writeFileSync(join(repo, 'base.txt'), 'resolved\n')
    git(repo, 'add', 'base.txt')

    // BEFORE the fix: the unscoped `diff --cached --check` would see
    // member_whitespace.txt's trailing whitespace and reject this perfectly
    // valid resolution. AFTER: scoped to paths both sides changed (base.txt
    // only — member_whitespace.txt was only ever touched by one side), the
    // check passes.
    const validation = await validateBenchResolution(repo, 'test')

    expect(validation.ok).toBe(true)
    git(repo, 'commit', '--no-edit')
  })
})
