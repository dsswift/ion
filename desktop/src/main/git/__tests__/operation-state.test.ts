/**
 * Pins the zero-spawn contract of the operation probe: a quiescent checkout is
 * answered from the filesystem alone (this probe runs per worktree per
 * inventory crawl — its former 2–4 `rev-parse` spawns each were a large slice
 * of the spawn storm that froze the overlay), and both gitdir layouts —
 * primary `.git` directory and linked-worktree `.git` pointer file — resolve
 * to the correct state dirs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../git-runner', () => ({ runGit: vi.fn() }))

import { runGit } from '../../git-runner'
import { probeOperationState } from '../operation-state'

const runGitMock = vi.mocked(runGit)

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-opstate-'))
  runGitMock.mockReset()
  runGitMock.mockResolvedValue('')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A primary checkout: `.git` is the gitdir itself. */
function makePrimary(): string {
  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  return repo
}

/** A linked worktree: `.git` is a pointer file naming the real gitdir. */
function makeLinkedWorktree(): { wt: string; gitDir: string } {
  const gitDir = join(root, 'repo', '.git', 'worktrees', 'ion-abc123')
  mkdirSync(gitDir, { recursive: true })
  const wt = join(root, 'wt')
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${gitDir}\n`)
  return { wt, gitDir }
}

describe('probeOperationState', () => {
  it('answers a quiescent primary checkout with zero git spawns', async () => {
    const repo = makePrimary()
    const probe = await probeOperationState(repo)
    expect(probe.state).toBeUndefined()
    expect(probe.conflictedPaths).toEqual([])
    expect(runGitMock).not.toHaveBeenCalled()
  })

  it('answers a quiescent linked worktree with zero git spawns', async () => {
    const { wt } = makeLinkedWorktree()
    const probe = await probeOperationState(wt)
    expect(probe.state).toBeUndefined()
    expect(runGitMock).not.toHaveBeenCalled()
  })

  it('answers a non-repo directory with zero git spawns, failing open', async () => {
    const dir = join(root, 'not-a-repo')
    mkdirSync(dir)
    const probe = await probeOperationState(dir)
    expect(probe.state).toBeUndefined()
    expect(runGitMock).not.toHaveBeenCalled()
  })

  it('detects a rebase in a primary checkout and recovers the branch', async () => {
    const repo = makePrimary()
    const rebaseDir = join(repo, '.git', 'rebase-merge')
    mkdirSync(rebaseDir)
    writeFileSync(join(rebaseDir, 'head-name'), 'refs/heads/wt/ion-feature\n')
    writeFileSync(join(rebaseDir, 'onto'), 'abcdef0123456789\n')

    const probe = await probeOperationState(repo)
    expect(probe.state).toBe('rebasing')
    expect(probe.branch).toBe('wt/ion-feature')
    expect(probe.onto).toBe('abcdef0')
    // The only git reachable from a detected operation is the conflict list.
    for (const call of runGitMock.mock.calls) {
      expect(call[1]).toEqual(['ls-files', '--unmerged'])
    }
  })

  it('detects a rebase through a linked worktree pointer file', async () => {
    const { wt, gitDir } = makeLinkedWorktree()
    const rebaseDir = join(gitDir, 'rebase-merge')
    mkdirSync(rebaseDir)
    writeFileSync(join(rebaseDir, 'head-name'), 'refs/heads/wt/ion-linked\n')

    const probe = await probeOperationState(wt)
    expect(probe.state).toBe('rebasing')
    expect(probe.branch).toBe('wt/ion-linked')
  })

  it('detects a merge via MERGE_HEAD and returns conflicted paths deduped', async () => {
    const repo = makePrimary()
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), 'abc\n')
    runGitMock.mockResolvedValue(
      '100644 aaaa 1\tsrc/conflict.ts\n100644 bbbb 2\tsrc/conflict.ts\n100644 cccc 3\tsrc/conflict.ts\n',
    )
    const probe = await probeOperationState(repo)
    expect(probe.state).toBe('merging')
    expect(probe.conflictedPaths).toEqual(['src/conflict.ts'])
  })

  it('detects a cherry-pick via CHERRY_PICK_HEAD', async () => {
    const repo = makePrimary()
    writeFileSync(join(repo, '.git', 'CHERRY_PICK_HEAD'), 'abc\n')
    const probe = await probeOperationState(repo)
    expect(probe.state).toBe('cherry-picking')
  })
})
