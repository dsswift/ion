/**
 * Land against a real repository whose commit-msg hook matters: the hook must
 * find the operator's tools, and a hook that refuses must not leave the merge
 * open in the operator's checkout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { execFileSync } from 'child_process'

const cliPath = vi.hoisted(() => ({ value: '' }))

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../cli-env', () => ({ getCliPath: () => cliPath.value }))
vi.mock('../inventory', () => ({
  lookupWorktreeLandedAt: vi.fn(() => null),
  markWorktreeLanded: vi.fn(() => true),
}))
vi.mock('../../integration/bench-ops', () => ({
  disenrollWorktree: vi.fn(() => ({ removedFrom: 0, prunedBenches: [] })),
}))
vi.mock('../lifecycle-automation-trigger', () => ({ triggerWorktreeLifecycleAutomation: vi.fn() }))
vi.mock('../relocate', () => ({ retireWorktreeUnqueued: vi.fn() }))

import { landWorktreeUnqueued } from '../integrate'

let root: string
let repo: string
let worktree: string
let toolDir: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function writeHook(body: string): void {
  const hooks = join(root, 'hooks')
  mkdirSync(hooks, { recursive: true })
  const hook = join(hooks, 'commit-msg')
  writeFileSync(hook, `#!/bin/sh\n${body}\n`)
  chmodSync(hook, 0o755)
  git(repo, 'config', 'core.hooksPath', hooks)
}

function land() {
  return landWorktreeUnqueued({
    repoPath: repo,
    worktreePath: worktree,
    worktreeBranch: 'wt/feature',
    sourceBranch: 'main',
    noFf: true,
  })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-land-hooks-')))
  repo = join(root, 'repo')
  worktree = join(root, 'wt')
  toolDir = join(root, 'tools')
  mkdirSync(repo)
  mkdirSync(toolDir)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'user@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'worktree', 'add', '-q', '-b', 'wt/feature', worktree)
  writeFileSync(join(worktree, 'b.txt'), 'b\n')
  git(worktree, 'add', 'b.txt')
  git(worktree, 'commit', '-q', '-m', 'feature')

  // A tool the hook needs that only the operator's shell PATH can see, the
  // way husky's `npx` lives in /opt/homebrew/bin outside launchd's PATH.
  const tool = join(toolDir, 'ion-test-hook-tool')
  writeFileSync(tool, '#!/bin/sh\nexit 0\n')
  chmodSync(tool, 0o755)
  cliPath.value = [toolDir, process.env.PATH].join(delimiter)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('land: repository hooks', () => {
  it('runs hooks with the operator PATH, not the inherited process PATH', async () => {
    expect(process.env.PATH?.split(delimiter)).not.toContain(toolDir)
    writeHook('ion-test-hook-tool')

    const result = await land()

    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Merge wt/feature into main')
  })

  it('aborts the merge when a hook refuses, leaving the checkout as it was', async () => {
    const before = git(repo, 'rev-parse', 'HEAD')
    writeHook('echo "hook refused" >&2; exit 1')

    const result = await land()

    expect(result.ok).toBe(false)
    expect(result.hasConflicts).toBeFalsy()
    expect(result.error).toContain('hook refused')
    expect(result.error).toContain('The merge was aborted')
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
  })
})
