import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GIT_FIXTURE_TIMEOUT } from '../../test/git-fixture-timeout'

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_RESOLVE || actual.homedir() }
})

import { assembleBench } from '../bench-assemble'
import { prepareConflictResolution } from '../bench-resolve'
import { captureContribution } from '../bench-snapshot'
import { loadWorkspaces, makeMember, makeWorkspace, saveWorkspaces } from '../bench-store'
import { refreshStaleness, removeMember } from '../bench-ops'
import type { IntegrationMember, IntegrationWorkspace } from '@ion/shared/types'

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
  // realpath.native: macOS resolves /var's symlink and Windows expands a
  // short (8.3) TEMP path to the long form git itself reports; plain
  // realpathSync does not perform the Windows expansion.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ion-bench-resolve-')))
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
}, GIT_FIXTURE_TIMEOUT)

/**
 * The open merge belongs to the bench, not to a member row. These pin the
 * dead end where the conflicted member left the bench (or lost its pin) and
 * every door to Continue/Abort closed while assembly stayed refused.
 */
describe('an open resolution merge stays reachable', () => {
  async function openConflict(): Promise<IntegrationWorkspace> {
    const ws = await fixture()
    await assembleBench(ws)
    const prepared = await prepareConflictResolution(repo, 'main')
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, mergeOpen: true, branchName: 'wt/c' })
    return ws
  }

  it('reports the merge on the workspace from the bench git state', async () => {
    const ws = await openConflict()
    const refreshed = await refreshStaleness(repo, 'main')
    expect(refreshed!.resolutionOpen).toEqual({ unmergedPaths: 1 })
    expect(loadWorkspaces()[0].resolutionOpen).toEqual({ unmergedPaths: 1 })

    git(ws.benchPath, 'merge', '--abort')
    expect((await refreshStaleness(repo, 'main'))!.resolutionOpen).toBeUndefined()
    expect(loadWorkspaces()[0].resolutionOpen).toBeUndefined()
  })

  it('still reports the merge as open when no member holds its pin', async () => {
    const ws = await openConflict()
    // The record loses the conflicted member without the merge being touched.
    saveWorkspaces([{ ...ws, members: [ws.members[0]] }])

    const result = await prepareConflictResolution(repo, 'main')

    expect(result).toMatchObject({ ok: true, mergeOpen: true, benchPath: ws.benchPath })
    expect(result.branchName).toBeUndefined()
  })

  it('aborts the merge when its member is removed, and keeps any other merge', async () => {
    const ws = await openConflict()
    const mergeHead = (): string => git(ws.benchPath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()

    await removeMember(repo, 'main', ws.members[0].worktreePath)
    expect(mergeHead()).toBe(ws.members[1].pinnedSha)

    const next = await removeMember(repo, 'main', ws.members[1].worktreePath)
    expect(() => mergeHead()).toThrow()
    expect(next!.resolutionOpen).toBeUndefined()
    expect((await prepareConflictResolution(repo, 'main')).mergeOpen).toBe(false)
  })

  it('reports no open merge when everything merges cleanly', async () => {
    const ws = await fixture()
    await assembleBench(ws)
    recordResolution(ws, 'valid combined resolution\n')
    expect((await prepareConflictResolution(repo, 'main')).mergeOpen).toBe(false)
  })
}, GIT_FIXTURE_TIMEOUT)
