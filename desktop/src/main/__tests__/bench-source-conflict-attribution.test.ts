import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_SOURCE_CONFLICT || actual.homedir() }
})

import { assembleBench } from '../integration/bench-assemble'
import { captureContribution } from '../integration/bench-snapshot'
import { makeWorkspace, makeMember } from '../integration/bench-store'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-bench-source-conflict-')))
  process.env.ION_TEST_HOME_BENCH_SOURCE_CONFLICT = join(root, 'home')
  repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf-8' })
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Dev')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'base')
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_SOURCE_CONFLICT
  removeGitFixture(root)
})

describe('assembleBench source-branch conflict attribution', () => {
  it('names source when its post-fork changes conflict with the only member', async () => {
    const worktreePath = join(root, 'member')
    git(repo, 'worktree', 'add', '-b', 'wt/member', worktreePath, 'main')
    writeFileSync(join(worktreePath, 'shared.txt'), 'from member\n')
    git(worktreePath, 'add', '-A')
    git(worktreePath, 'commit', '-m', 'member changes shared path')
    const contribution = await captureContribution(worktreePath, 'main', 'wt/member')
    const member = makeMember({
      worktreePath,
      branchName: 'wt/member',
      pinnedSha: contribution.sha,
      pinnedTreeHash: contribution.treeHash,
      pinnedBaseSha: contribution.baseSha,
    })

    writeFileSync(join(repo, 'shared.txt'), 'from source\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'source changes shared path')

    const base = makeWorkspace(repo, 'main')
    const workspace = {
      ...base,
      benchPath: join(root, 'bench'),
      benchBranch: 'ion/bench/source-conflict',
      members: [member],
    }
    const result = await assembleBench(workspace)

    expect(result.ok).toBe(true)
    const conflicted = result.workspace!.members[0]
    expect(conflicted.merge).toBe('conflicted')
    expect(conflicted.conflictPaths).toContain('shared.txt')
    expect(conflicted.conflictsWith).toEqual(['main'])
    expect(result.workspace!.lastAssemblyError).toContain('with main')
  })
})
