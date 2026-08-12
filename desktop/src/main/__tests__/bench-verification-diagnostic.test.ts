/**
 * prepareVerificationDiagnostic — rebuild the failing tree back into the
 * bench for the AI-assisted analysis conversation, without wiping it.
 *
 * Real repos, not mocks: the merge/replay behaviour under test is git rerere's.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_DIAGNOSTIC || actual.homedir() }
})

import { assembleBench } from '../integration/bench-assemble'
import { prepareVerificationDiagnostic } from '../integration/bench-verification-diagnostic'
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

function declareBenchVerify(command: string): void {
  mkdirSync(join(repo, '.ion'), { recursive: true })
  writeFileSync(join(repo, '.ion', 'worktree.json'), JSON.stringify({
    version: 1,
    bench: { verify: command },
  }))
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

function resolveOnceInBench(ws: IntegrationWorkspace, conflictedSha: string, resolution: string): void {
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
    writeFileSync(join(ws.benchPath, 'shared.txt'), resolution)
    git(ws.benchPath, 'add', 'shared.txt')
    git(ws.benchPath, '-c', 'core.editor=true', 'merge', '--continue')
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-bench-diagnostic-')))
  process.env.ION_TEST_HOME_BENCH_DIAGNOSTIC = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_DIAGNOSTIC
  removeGitFixture(root)
})

describe('prepareVerificationDiagnostic', () => {
  it('rebuilds the failing tree, does NOT wipe it, and captures fresh verify evidence', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])
    await assembleBench(ws)
    resolveOnceInBench(ws, ws.members[1].pinnedSha, 'poisoned resolution\n')
    declareBenchVerify('exit 1')
    const failed = await assembleBench(ws)
    expect(failed.workspace!.lastAssembly).toBe('failed')
    // The atomic wipe already ran: nothing is on disk.
    expect(existsSync(join(ws.benchPath, 'shared.txt'))).toBe(false)

    const result = await prepareVerificationDiagnostic(repo, 'main', failed.workspace!)

    expect(result.ok).toBe(true)
    // Unlike a plain reassembly, the tree is left in place for the agent to read.
    expect(existsSync(join(ws.benchPath, 'shared.txt'))).toBe(true)
    expect(result.workspace!.lastAssemblyVerification?.command).toBe('exit 1')
    expect(result.workspace!.lastAssemblyVerification?.replayedBranches).toContain('wt/c')
    expect(result.workspace!.lastAssemblyVerification?.diagnosticTreeAt).toBeGreaterThan(0)
  })

  it('refuses without wiping when a member no longer merges the same way', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])
    await assembleBench(ws)
    resolveOnceInBench(ws, ws.members[1].pinnedSha, 'poisoned resolution\n')
    declareBenchVerify('exit 1')
    const failed = await assembleBench(ws)

    // The state changed since the failure: the recording is gone.
    git(ws.benchPath, 'rerere', 'forget', '--', 'shared.txt')
    // But forget outside merge context is a no-op in real rerere too unless a
    // conflict is active -- simulate the "state moved" case more directly by
    // rewriting the member's pin to a commit that no longer conflicts the
    // same way: append content that changes the conflicting lines.
    writeFileSync(join(c.path, 'shared.txt'), 'from c, reworked\n')
    git(c.path, 'add', '-A')
    git(c.path, 'commit', '-m', 'c: rework conflicting lines')
    const advancedC = await enroll(c)
    const movedWs: IntegrationWorkspace = {
      ...failed.workspace!,
      members: failed.workspace!.members.map((m) => (m.branchName === 'wt/c' ? { ...m, ...advancedC } : m)),
    }

    const result = await prepareVerificationDiagnostic(repo, 'main', movedWs)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no longer merges/i)
  })

  it('leaves ignored build output untouched, exactly like a normal assembly', async () => {
    const a = makeWorktree('a', 'shared.txt', 'from a\n')
    const c = makeWorktree('c', 'shared.txt', 'from c\n')
    const ws = workspaceFor([await enroll(a), await enroll(c)])
    await assembleBench(ws)
    resolveOnceInBench(ws, ws.members[1].pinnedSha, 'poisoned resolution\n')
    declareBenchVerify('exit 1')
    const failed = await assembleBench(ws)
    mkdirSync(join(ws.benchPath, 'node_modules'), { recursive: true })
    writeFileSync(join(ws.benchPath, 'node_modules', '.probe'), 'expensive build output\n')

    await prepareVerificationDiagnostic(repo, 'main', failed.workspace!)

    expect(execFileSync('cat', [join(ws.benchPath, 'node_modules', '.probe')], { encoding: 'utf-8' }))
      .toBe('expensive build output\n')
  })
}, GIT_FIXTURE_TIMEOUT)
