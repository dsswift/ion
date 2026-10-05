/**
 * Ephemeral worktrees, against REAL git: the policy read from
 * `.ion/worktree.json`, the registry record, the inventory field the worktree
 * list renders, creation's default, and the refuse-if-unlanded discard the
 * close path relies on.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Per-file env var: vitest runs test files concurrently in one process.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_WT_EPHEMERAL || actual.homedir() }
})

import { readEphemeralPolicy } from '../ephemeral-policy'
import { keepEphemeralWorktree, lookupEphemeralState, setEphemeralWorktreeOwner } from '../registry-ephemeral'
import { lookupWorktreeRegistration, registerWorktree } from '../registry'
import { inventoryWorktrees } from '../inventory'
import { discardWorktree } from '../relocate'
import { gitWorktreeAdd } from '../../store/host-api-git'

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
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  return dir
}

function makeWorktree(name: string, commit: boolean): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, 'main')
  if (commit) {
    writeFileSync(join(path, `${name}.txt`), `${name}\n`)
    git(path, 'add', '-A')
    git(path, 'commit', '-m', `${name} work`)
  }
  registerWorktree({ worktreePath: path, repoPath: repo, branchName: branch, sourceBranch: 'main', ephemeral: { ownerTabId: 'tab-1' } })
  return { path, branch }
}

function writeManifest(worktree: Record<string, unknown>): void {
  mkdirSync(join(repo, '.ion'), { recursive: true })
  writeFileSync(join(repo, '.ion', 'worktree.json'), JSON.stringify({ version: 1, worktree }))
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ion-wt-eph-')))
  process.env.ION_TEST_HOME_WT_EPHEMERAL = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_WT_EPHEMERAL
  removeGitFixture(root)
})

describe('readEphemeralPolicy', () => {
  it('defaults to off and never-discard with no manifest', () => {
    expect(readEphemeralPolicy(repo)).toEqual({ ephemeralDefault: false, ephemeralMayDiscard: false })
  })

  it('reads both flags from the worktree block', () => {
    writeManifest({ ephemeralDefault: true, ephemeralMayDiscard: true })
    expect(readEphemeralPolicy(repo)).toEqual({ ephemeralDefault: true, ephemeralMayDiscard: true })
  })

  it('treats a mistyped flag as the default, so a typo never grants discard', () => {
    writeManifest({ ephemeralDefault: 'yes', ephemeralMayDiscard: 'true' })
    expect(readEphemeralPolicy(repo)).toEqual({ ephemeralDefault: false, ephemeralMayDiscard: false })
  })
})

describe('ephemeral registry record', () => {
  it('records the owner, and keeping it makes the worktree ordinary with a reason', () => {
    const wt = makeWorktree('a', false)
    expect(lookupWorktreeRegistration(wt.path)?.ephemeral).toEqual({ ownerTabId: 'tab-1' })
    expect(setEphemeralWorktreeOwner(wt.path, 'tab-2')).toBe(true)
    expect(lookupWorktreeRegistration(wt.path)?.ephemeral).toEqual({ ownerTabId: 'tab-2' })

    expect(keepEphemeralWorktree(wt.path, '1 commit not yet landed in main.')).toBe(true)
    expect(lookupEphemeralState(wt.path)).toEqual({ ephemeral: false, keptReason: '1 commit not yet landed in main.' })
    expect(lookupWorktreeRegistration(wt.path)?.ephemeral).toBeUndefined()
  })

  it('refuses to bind an owner to an ordinary worktree', () => {
    const path = join(root, 'plain')
    git(repo, 'worktree', 'add', '-b', 'wt/plain', path, 'main')
    registerWorktree({ worktreePath: path, repoPath: repo, branchName: 'wt/plain', sourceBranch: 'main' })
    expect(setEphemeralWorktreeOwner(path, 'tab-1')).toBe(false)
    expect(lookupEphemeralState(path).ephemeral).toBe(false)
  })

  it('reaches the worktree list as a serializable field', async () => {
    const eph = makeWorktree('eph', false)
    const kept = makeWorktree('kept', false)
    keepEphemeralWorktree(kept.path, 'Removing it failed: busy')

    const listed = JSON.parse(JSON.stringify(await inventoryWorktrees(repo))) as Array<Record<string, unknown>>
    const byPath = new Map(listed.map((e) => [e.worktreePath, e]))
    expect(byPath.get(eph.path)?.ephemeral).toBe(true)
    expect(byPath.get(eph.path)?.ephemeralKeptReason).toBeUndefined()
    expect(byPath.get(kept.path)?.ephemeral).toBeUndefined()
    expect(byPath.get(kept.path)?.ephemeralKeptReason).toBe('Removing it failed: busy')
  })
})

describe('gitWorktreeAdd ephemeral default', () => {
  it('applies the project default only to a worktree cut for a conversation', async () => {
    writeManifest({ ephemeralDefault: true })
    const forConversation = await gitWorktreeAdd(repo, 'main', { ownerTabId: 'tab-9' })
    const standalone = await gitWorktreeAdd(repo, 'main')
    const declined = await gitWorktreeAdd(repo, 'main', { ephemeral: false })

    expect(forConversation.ephemeral).toBe(true)
    expect(lookupWorktreeRegistration(forConversation.worktree!.worktreePath)?.ephemeral).toEqual({ ownerTabId: 'tab-9' })
    expect(standalone.ephemeral).toBe(false)
    expect(lookupEphemeralState(standalone.worktree!.worktreePath).ephemeral).toBe(false)
    expect(declined.ephemeral).toBe(false)
  })

  it('leaves the default off with no manifest', async () => {
    const result = await gitWorktreeAdd(repo, 'main', { ownerTabId: 'tab-9' })
    expect(result.ephemeral).toBe(false)
  })
})

describe('discardWorktree onlyIfSafe', () => {
  it('refuses and keeps the checkout when the worktree has unlanded commits', async () => {
    const wt = makeWorktree('busy', true)
    const result = await discardWorktree({ repoPath: repo, worktreePath: wt.path, branchName: wt.branch, sourceBranch: 'main', onlyIfSafe: true })

    expect(result.ok).toBe(false)
    expect(result.refusedUnlanded).toBe(true)
    expect(result.error).toContain('1 commit not yet landed in main')
    expect(existsSync(wt.path)).toBe(true)
    expect(git(repo, 'for-each-ref', 'refs/ion/discarded').trim()).toBe('')
  })

  it('refuses on uncommitted files too', async () => {
    const wt = makeWorktree('dirty', false)
    writeFileSync(join(wt.path, 'scratch.txt'), 'x\n')
    const result = await discardWorktree({ repoPath: repo, worktreePath: wt.path, branchName: wt.branch, sourceBranch: 'main', onlyIfSafe: true })

    expect(result.refusedUnlanded).toBe(true)
    expect(existsSync(join(wt.path, 'scratch.txt'))).toBe(true)
  })

  it('removes a worktree with nothing to lose', async () => {
    const wt = makeWorktree('clean', false)
    const result = await discardWorktree({ repoPath: repo, worktreePath: wt.path, branchName: wt.branch, sourceBranch: 'main', onlyIfSafe: true })

    expect(result.ok).toBe(true)
    expect(existsSync(wt.path)).toBe(false)
    expect(lookupWorktreeRegistration(wt.path)).toBeNull()
  })
})
