/**
 * syncAllWorktrees — the bulk pass, against REAL git.
 *
 * The mechanics under it (stored-base rebases, rerere replay, auto-complete)
 * are pinned in worktree-sync-mechanics.test.ts. These tests pin the PASS:
 * every worktree of a repo classified into a typed outcome, dirty trees never
 * touched, and the in-pass rerere cascade (a resolution recorded before the
 * pass clears a later identical conflict by replay, attributed as such).
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME so registry reads/writes land in the fixture. Per-file env var:
// vitest runs test FILES concurrently in one process.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_WT_SYNCALL || actual.homedir() }
})

import { registerWorktree } from '../worktree/inventory'
import { syncWorktreeFromSource } from '../worktree/integrate'
import { syncAllWorktreesUnqueued } from '../worktree/sync-all'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

const FEATURE = 'josh'

function makeRepo(): string {
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf-8' })
  git(dir, 'config', 'user.email', 'dev@example.com')
  git(dir, 'config', 'user.name', 'Dev')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'upstream.txt'), 'u1\nu2\nu3\n')
  writeFileSync(join(dir, 'shared.txt'), 'line1\nline2\nline3\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  git(dir, 'branch', FEATURE)
  git(dir, 'checkout', '-b', 'parking')
  return dir
}

function makeWorktree(name: string): { path: string; branch: string } {
  const path = join(root, name)
  const branch = `wt/${name}`
  git(repo, 'worktree', 'add', '-b', branch, path, FEATURE)
  const baseAtCut = git(path, 'rev-parse', 'HEAD').trim()
  registerWorktree({
    worktreePath: path, repoPath: repo, branchName: branch, sourceBranch: FEATURE,
    baseSha: baseAtCut,
  })
  return { path, branch }
}

function commitOnFeature(file: string, content: string, message: string): void {
  const holder = join(root, `holder-${Math.random().toString(36).slice(2, 8)}`)
  git(repo, 'worktree', 'add', holder, FEATURE)
  writeFileSync(join(holder, file), content)
  git(holder, 'add', '-A')
  git(holder, 'commit', '-m', message)
  git(repo, 'worktree', 'remove', '--force', holder)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-wtsyncall-')))
  process.env.ION_TEST_HOME_WT_SYNCALL = join(root, 'home')
  repo = makeRepo()
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_WT_SYNCALL
  removeGitFixture(root)
})

describe('syncAllWorktrees — the bulk pass classifies every row', () => {
  it('handles a mixed board: current, stale, dirty, and conflicted', async () => {
    // stale: own commit, no conflict with the upstream move.
    const stale = makeWorktree('stale')
    writeFileSync(join(stale.path, 'shared.txt'), 'line1\nline2\nSTALE EDIT\n')
    git(stale.path, 'add', '-A')
    git(stale.path, 'commit', '-m', 'stale: edit line3')
    // dirty: uncommitted work.
    const dirty = makeWorktree('dirty')
    writeFileSync(join(dirty.path, 'shared.txt'), 'line1\nline2\nUNCOMMITTED\n')
    // conflicted: committed edit that collides with the upstream move.
    const conflicted = makeWorktree('conflicted')
    writeFileSync(join(conflicted.path, 'upstream.txt'), 'CONFLICT EDIT\nu2\nu3\n')
    git(conflicted.path, 'add', '-A')
    git(conflicted.path, 'commit', '-m', 'conflicted: edit u1')

    // The source branch moves u1 — stale rebases clean, conflicted collides.
    commitOnFeature('upstream.txt', 'u1 MOVED\nu2\nu3\n', 'feature: move u1')

    // current: cut AFTER the move, so its tree already matches the source tip
    // and needsSync is genuinely false. (A no-commit worktree cut BEFORE the
    // move still needs sync — its tree changes — which is why this row is
    // created last.)
    const current = makeWorktree('current')

    const result = await syncAllWorktreesUnqueued(repo)
    expect(result.ok).toBe(true)

    const byPath = new Map(result.outcomes.map((o) => [o.worktreePath, o]))
    expect(byPath.get(current.path)?.outcome).toBe('skipped-clean')
    expect(byPath.get(stale.path)?.outcome).toBe('synced')
    expect(byPath.get(dirty.path)?.outcome).toBe('skipped-dirty')
    expect(byPath.get(conflicted.path)?.outcome).toBe('conflicted')
    expect(byPath.get(conflicted.path)?.conflictedPaths).toEqual(['upstream.txt'])

    // The dirty tree was never touched.
    expect(readFileSync(join(dirty.path, 'shared.txt'), 'utf-8')).toContain('UNCOMMITTED')
    expect(result.summary).toMatchObject({
      synced: 1, conflicted: 1, skippedDirty: 1, failed: 0,
    })
    // Leave no rebase running for teardown.
    git(conflicted.path, 'rebase', '--abort')
  })

  it('the pass itself cascades: an early resolution clears a later identical conflict', async () => {
    // Both worktrees carry the identical conflicting edit. Worktree A's
    // conflict is resolved before the pass (simulating the operator or a
    // previous pipeline round); the pass then syncs B by replay.
    const a = makeWorktree('a')
    const b = makeWorktree('wtb')
    for (const wt of [a, b]) {
      writeFileSync(join(wt.path, 'shared.txt'), 'line1\nWORKTREE CHANGE\nline3\n')
      git(wt.path, 'add', '-A')
      git(wt.path, 'commit', '-m', 'edit shared')
    }
    commitOnFeature('shared.txt', 'line1\nFEATURE CHANGE\nline3\n', 'feature: conflicting edit')

    const first = await syncWorktreeFromSource(a.path, FEATURE)
    expect(first.hasConflicts).toBe(true)
    writeFileSync(join(a.path, 'shared.txt'), 'line1\nRESOLVED\nline3\n')
    git(a.path, 'add', 'shared.txt')
    git(a.path, '-c', 'core.editor=true', 'rebase', '--continue')

    const result = await syncAllWorktreesUnqueued(repo)
    const byPath = new Map(result.outcomes.map((o) => [o.worktreePath, o]))
    // A already synced during its manual resolution → nothing to do.
    expect(byPath.get(a.path)?.outcome).toBe('skipped-clean')
    // B completed from the recording, attributed as replayed, not synced.
    expect(byPath.get(b.path)?.outcome).toBe('replayed')
  })

  it('reports skipped-unknown-source for worktrees with no source branch', async () => {
    const unknown = makeWorktree('unknown-src')

    // Overwrite the registry entry to clear the source branch.
    const registryPath = join(root, 'home', '.ion', 'worktree-registry.json')
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
    const entry = registry.entries.find((e: { worktreePath: string }) => e.worktreePath === unknown.path)
    entry.sourceBranch = null
    writeFileSync(registryPath, JSON.stringify(registry))

    const result = await syncAllWorktreesUnqueued(repo)
    const byPath = new Map(result.outcomes.map((o) => [o.worktreePath, o]))
    expect(byPath.get(unknown.path)?.outcome).toBe('skipped-unknown-source')
    expect(result.summary.skippedUnknownSource).toBe(1)
  })
})
