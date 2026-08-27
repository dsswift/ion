/**
 * GIT_WORKTREE_REBASE — the channel delegates to the sync verb.
 *
 * The original handler ran its own `git rebase` and detected conflicts with
 * `msg.includes('CONFLICT')` — the exact string-match defect hasMergeConflict
 * (worktree/integrate.ts) documents: git writes "CONFLICT (...)" lines to
 * STDOUT, which the captured stderr does not contain, so a genuine conflict
 * was reported as `hasConflicts: false` and the caller rendered a raw error
 * instead of the resolution UI. These tests drive the REAL handler through a
 * captured ipcMain registry against a real repo, pinning that conflicts are
 * now detected from the unmerged index.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_WT_REBASE || actual.homedir() }
})

/** Captured IPC handlers, keyed by channel. */
const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()

vi.mock('electron', () => ({
  app: { commandLine: { appendSwitch: vi.fn() }, getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn)
    },
  },
}))

import { registerWorktreeIpc } from '../ipc/worktree'
import { IPC } from '../../shared/types'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

const FEATURE = 'josh'

beforeEach(() => {
  handlers.clear()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-wtrebase-')))
  process.env.ION_TEST_HOME_WT_REBASE = join(root, 'home')

  // An upstream so the handler's `git fetch origin` has something to talk to.
  const upstream = join(root, 'upstream')
  execFileSync('git', ['init', '--bare', '-b', 'main', upstream], { encoding: 'utf-8' })

  repo = join(root, 'repo')
  execFileSync('git', ['clone', upstream, repo], { encoding: 'utf-8' })
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Dev')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'shared.txt'), 'line1\nline2\nline3\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'base')
  git(repo, 'branch', FEATURE)
  git(repo, 'push', 'origin', 'main', FEATURE)
  git(repo, 'checkout', '-b', 'parking')

  registerWorktreeIpc()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_WT_REBASE
  removeGitFixture(root)
})

function makeWorktree(name: string): string {
  const path = join(root, name)
  git(repo, 'worktree', 'add', '-b', `wt/${name}`, path, FEATURE)
  return path
}

function commitOnFeature(content: string): void {
  const holder = join(root, `holder-${Math.random().toString(36).slice(2, 8)}`)
  git(repo, 'worktree', 'add', holder, FEATURE)
  writeFileSync(join(holder, 'shared.txt'), content)
  git(holder, 'add', '-A')
  git(holder, 'commit', '-m', 'feature: edit shared')
  git(repo, 'worktree', 'remove', '--force', holder)
}

describe('GIT_WORKTREE_REBASE delegates to the sync verb', () => {
  it('reports a genuine conflict via the unmerged index, not a message match', async () => {
    const wt = makeWorktree('a')
    writeFileSync(join(wt, 'shared.txt'), 'line1\nWORKTREE\nline3\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-m', 'a: edit shared')
    commitOnFeature('line1\nFEATURE\nline3\n')

    const handler = handlers.get(IPC.GIT_WORKTREE_REBASE)!
    const result = await handler({}, { worktreePath: wt, sourceBranch: FEATURE }) as
      { ok: boolean; hasConflicts?: boolean }

    // RED before the fix: the CONFLICT lines go to stdout, so the string
    // match reported hasConflicts:false for exactly this state.
    expect(result.ok).toBe(false)
    expect(result.hasConflicts).toBe(true)
    git(wt, 'rebase', '--abort')
  })

  it('rebases a non-conflicting worktree cleanly', async () => {
    const wt = makeWorktree('b')
    writeFileSync(join(wt, 'other.txt'), 'own work\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-m', 'b: own file')
    commitOnFeature('line1\nFEATURE\nline3\n')

    const handler = handlers.get(IPC.GIT_WORKTREE_REBASE)!
    const result = await handler({}, { worktreePath: wt, sourceBranch: FEATURE }) as
      { ok: boolean; hasConflicts?: boolean }

    expect(result.ok).toBe(true)
    // The sync verb's dirty-refusal preflight rides along: verify the rebase
    // actually landed the feature commit under the worktree's own.
    expect(git(wt, 'rev-list', '--count', `${FEATURE}..HEAD`).trim()).toBe('1')
  })

  it('refuses a dirty worktree with an actionable message instead of a raw git error', async () => {
    const wt = makeWorktree('c')
    writeFileSync(join(wt, 'shared.txt'), 'line1\nUNCOMMITTED\nline3\n')
    commitOnFeature('line1\nFEATURE\nline3\n')

    const handler = handlers.get(IPC.GIT_WORKTREE_REBASE)!
    const result = await handler({}, { worktreePath: wt, sourceBranch: FEATURE }) as
      { ok: boolean; error?: string; hasConflicts?: boolean }

    expect(result.ok).toBe(false)
    expect(result.hasConflicts).toBeFalsy()
    expect(result.error).toContain('uncommitted changes')
  })
})
