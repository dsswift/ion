import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_RESOLVE || actual.homedir() }
})

import { assembleBench } from '../integration/bench-assemble'
import { prepareConflictResolution } from '../integration/bench-resolve'
import { captureContribution } from '../integration/bench-snapshot'
import { makeMember, makeWorkspace, saveWorkspaces } from '../integration/bench-store'
import type { IntegrationMember, IntegrationWorkspace } from '../../shared/types'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

function worktree(name: string, content: string): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, 'main')
  writeFileSync(join(path, 'shared.txt'), content)
  git(path, 'add', '-A')
  git(path, 'commit', '-m', `${name} work`)
  return { path, branch }
}

async function member(wt: { path: string; branch: string }): Promise<IntegrationMember> {
  const contribution = await captureContribution(wt.path, 'main', wt.branch)
  return makeMember({
    worktreePath: wt.path,
    branchName: wt.branch,
    pinnedSha: contribution.sha,
    pinnedTreeHash: contribution.treeHash,
    pinnedBaseSha: contribution.baseSha,
  })
}

async function fixture(): Promise<IntegrationWorkspace> {
  const a = worktree('a', 'from a\n')
  const c = worktree('c', 'from c\n')
  const base = makeWorkspace(repo, 'main')
  const ws = {
    ...base,
    benchPath: join(root, 'bench'),
    benchBranch: 'ion/bench/test',
    members: [await member(a), await member(c)],
  }
  saveWorkspaces([ws])
  return ws
}

function recordResolution(ws: IntegrationWorkspace, content: string): void {
  git(ws.benchPath, 'config', 'rerere.enabled', 'true')
  git(ws.benchPath, 'config', 'rerere.autoUpdate', 'true')
  git(ws.benchPath, 'switch', '-C', ws.benchBranch, 'main', '--discard-changes')
  git(ws.benchPath, 'merge', '--no-ff', '-m', 'prior', ws.members[0].pinnedSha)
  expect(() => git(ws.benchPath, 'merge', '--no-ff', '-m', 'conflict', ws.members[1].pinnedSha)).toThrow()
  writeFileSync(join(ws.benchPath, 'shared.txt'), content)
  git(ws.benchPath, 'add', 'shared.txt')
  git(ws.benchPath, '-c', 'core.editor=true', 'merge', '--continue')
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-bench-resolve-')))
  process.env.ION_TEST_HOME_BENCH_RESOLVE = join(root, 'home')
  repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo])
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Dev')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'base')
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_RESOLVE
  removeGitFixture(root)
})

describe('prepareConflictResolution', () => {
  it('commits a valid full replay and finishes without an open conflict', async () => {
    const ws = await fixture()
    await assembleBench(ws)
    recordResolution(ws, 'valid combined resolution\n')

    const result = await prepareConflictResolution(repo, 'main')

    expect(result.ok).toBe(true)
    expect(result.branchName).toBeUndefined()
    expect(readFileSync(join(ws.benchPath, 'shared.txt'), 'utf-8')).toBe('valid combined resolution\n')
  })

  it('forgets fully autostaged whitespace poison and exposes fresh unmerged path', async () => {
    const ws = await fixture()
    await assembleBench(ws)
    recordResolution(ws, 'poisoned replay  \n')

    const result = await prepareConflictResolution(repo, 'main')

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, branchName: 'wt/c' })
    expect(git(ws.benchPath, 'rerere', 'status').trim()).toBe('shared.txt')
    expect(git(ws.benchPath, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('shared.txt')
    expect(readFileSync(join(ws.benchPath, 'shared.txt'), 'utf-8')).toContain('<<<<<<<')
  })

  it('forgets an invalid marker replay and exposes recreated real conflict', async () => {
    const ws = await fixture()
    await assembleBench(ws)
    recordResolution(ws, '<<<<<<< HEAD\nfrom a\n=======\nfrom c\n>>>>>>> wt/c\n')

    const result = await prepareConflictResolution(repo, 'main')

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, branchName: 'wt/c' })
    expect(git(ws.benchPath, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('shared.txt')
  })

  it('returns retained merge member when resolution is already open', async () => {
    const ws = await fixture()
    await assembleBench(ws)
    git(ws.benchPath, 'switch', '-C', ws.benchBranch, 'main', '--discard-changes')
    git(ws.benchPath, 'merge', '--no-ff', '-m', 'prior', ws.members[0].pinnedSha)
    expect(() => git(ws.benchPath, 'merge', '--no-ff', '-m', 'conflict', ws.members[1].pinnedSha)).toThrow()

    const result = await prepareConflictResolution(repo, 'main')

    expect(result).toMatchObject({ ok: true, benchPath: ws.benchPath, branchName: 'wt/c' })
    expect(git(ws.benchPath, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('shared.txt')
  })

  it('skips landed members while recreating the unresolved merge', async () => {
    const ws = await fixture()
    await assembleBench(ws)
    git(repo, 'update-ref', 'refs/heads/main', ws.members[0].pinnedSha)

    const result = await prepareConflictResolution(repo, 'main')

    expect(result).toMatchObject({ ok: true, benchPath: ws.benchPath, branchName: 'wt/c' })
    expect(git(ws.benchPath, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('shared.txt')
  })
})
