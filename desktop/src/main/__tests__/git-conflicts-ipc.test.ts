/**
 * Conflict-resolution IPC — against REAL conflicted git fixtures.
 *
 * Real repos rather than mocks: the behavior under test IS git's conflict
 * representation (index stages, ours/theirs inversion during a rebase,
 * delete-conflict shapes). A mocked runGit would only restate the commands.
 *
 * What is pinned:
 *  - GIT_OP_STATE names the rebase's branch and reports per-file shape rows;
 *  - GIT_CONFLICT_STAGES returns the three stages, with null (not '') for a
 *    missing stage;
 *  - GIT_CONFLICT_ACCEPT ours/theirs stages the file and empties the unmerged
 *    list, including the delete-conflict path where acceptance is `git rm`.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
  },
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME so the bench guard's workspace read stays inside the fixture.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_GIT_CONFLICTS || actual.homedir() }
})

import { registerGitConflictsIpc } from '../ipc/git-conflicts'
import { IPC } from '../../shared/types'

registerGitConflictsIpc()

async function invoke<T>(channel: string, payload: Record<string, unknown>): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return (await handler({}, payload)) as T
}

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
  writeFileSync(join(dir, 'shared.txt'), 'line1\nline2\nline3\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  return dir
}

/** Rebase `wt/topic` onto a moved `main`, conflicting on shared.txt. */
function strandConflictedRebase(): void {
  git(repo, 'checkout', '-b', 'wt/topic')
  writeFileSync(join(repo, 'shared.txt'), 'line1\nTOPIC\nline3\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'topic: edit shared')
  git(repo, 'checkout', 'main')
  writeFileSync(join(repo, 'shared.txt'), 'line1\nMAIN\nline3\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'main: conflicting edit')
  git(repo, 'checkout', 'wt/topic')
  try {
    git(repo, 'rebase', 'main')
    throw new Error('expected the rebase to conflict')
  } catch {
    // Conflicted mid-rebase — the state under test.
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-conflict-ipc-')))
  process.env.ION_TEST_HOME_GIT_CONFLICTS = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_GIT_CONFLICTS
  removeGitFixture(root)
})

describe('GIT_OP_STATE', () => {
  it('names the rebased branch and lists conflict rows with shapes', async () => {
    strandConflictedRebase()
    const result = await invoke<{
      ok: boolean
      state: string | null
      branch: string | null
      oursLabel: string
      theirsLabel: string
      files: Array<{ path: string; shape: string }>
    }>(IPC.GIT_OP_STATE, { directory: repo })

    expect(result.ok).toBe(true)
    expect(result.state).toBe('rebasing')
    expect(result.branch).toBe('wt/topic')
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('shared.txt')
    expect(result.files[0].shape).toBe('both modified')
    // The rebase inversion is translated into labels: "theirs" is the
    // operator's branch, and the UI names it rather than saying bare theirs.
    expect(result.theirsLabel).toBe('wt/topic')
  })

  it('reports no operation for a quiescent repo', async () => {
    const result = await invoke<{ ok: boolean; state: string | null; files: unknown[] }>(
      IPC.GIT_OP_STATE, { directory: repo },
    )
    expect(result.ok).toBe(true)
    expect(result.state).toBeNull()
    expect(result.files).toHaveLength(0)
  })
})

describe('GIT_CONFLICT_STAGES', () => {
  it('returns base, ours, and theirs for a both-modified file', async () => {
    strandConflictedRebase()
    const result = await invoke<{
      ok: boolean; base: string | null; ours: string | null; theirs: string | null
    }>(IPC.GIT_CONFLICT_STAGES, { directory: repo, path: 'shared.txt' })

    expect(result.ok).toBe(true)
    expect(result.base).toBe('line1\nline2\nline3\n')
    // During a rebase, stage 2 (ours) is the branch rebased ONTO (main) and
    // stage 3 (theirs) is the branch being rebased (wt/topic).
    expect(result.ours).toBe('line1\nMAIN\nline3\n')
    expect(result.theirs).toBe('line1\nTOPIC\nline3\n')
  })

  it('returns null, not empty, for a missing stage (add/add)', async () => {
    // Both branches add the same NEW file differently: no stage 1.
    git(repo, 'checkout', '-b', 'wt/add')
    writeFileSync(join(repo, 'new.txt'), 'added on topic\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'topic adds new.txt')
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'new.txt'), 'added on main\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'main adds new.txt')
    git(repo, 'checkout', 'wt/add')
    try { git(repo, 'rebase', 'main') } catch { /* conflicted, as intended */ }

    const result = await invoke<{ ok: boolean; base: string | null; ours: string | null; theirs: string | null }>(
      IPC.GIT_CONFLICT_STAGES, { directory: repo, path: 'new.txt' },
    )
    expect(result.ok).toBe(true)
    expect(result.base).toBeNull()
    expect(result.ours).toBe('added on main\n')
    expect(result.theirs).toBe('added on topic\n')
  })
})

describe('GIT_CONFLICT_ACCEPT', () => {
  it('accepting a side stages the file and clears the unmerged list', async () => {
    strandConflictedRebase()
    const result = await invoke<{ ok: boolean }>(
      IPC.GIT_CONFLICT_ACCEPT, { directory: repo, path: 'shared.txt', side: 'theirs' },
    )
    expect(result.ok).toBe(true)
    expect(git(repo, 'ls-files', '--unmerged').trim()).toBe('')
    // Theirs during this rebase is wt/topic's content.
    const staged = git(repo, 'show', ':0:shared.txt')
    expect(staged).toBe('line1\nTOPIC\nline3\n')
  })

  it('accepting the deleting side removes the file', async () => {
    // Topic deletes shared.txt; main modifies it. Rebase conflicts as
    // modify/delete; accepting "theirs" (topic, the deleter) must `git rm`.
    git(repo, 'checkout', '-b', 'wt/del')
    git(repo, 'rm', 'shared.txt')
    git(repo, 'commit', '-m', 'topic deletes shared')
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'shared.txt'), 'line1\nMAIN\nline3\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'main edits shared')
    git(repo, 'checkout', 'wt/del')
    try { git(repo, 'rebase', 'main') } catch { /* conflicted, as intended */ }

    const result = await invoke<{ ok: boolean }>(
      IPC.GIT_CONFLICT_ACCEPT, { directory: repo, path: 'shared.txt', side: 'theirs' },
    )
    expect(result.ok).toBe(true)
    expect(git(repo, 'ls-files', '--unmerged').trim()).toBe('')
    expect(existsSync(join(repo, 'shared.txt'))).toBe(false)
  })

  it('refuses a path that is not conflicted', async () => {
    const result = await invoke<{ ok: boolean; error?: string }>(
      IPC.GIT_CONFLICT_ACCEPT, { directory: repo, path: 'shared.txt', side: 'ours' },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not conflicted')
  })
})
