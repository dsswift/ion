/**
 * Bench-gate tests.
 *
 * The property that matters: an agent cannot write git history inside an
 * integration bench, because the next rebuild recreates the branch and destroys
 * the commit. Refusing is what turns silent work-loss into an actionable
 * message.
 *
 * Reading and building must stay unblocked -- that is the entire purpose of the
 * bench -- so over-blocking is as much a defect as under-blocking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let home: string

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => process.env.ION_BENCH_TEST_HOME || actual.homedir() }
})

import {
  gateBenchCommand, isBenchDirectory, extractGitSubcommands, _resetBenchCacheForTests,
} from '../../../../engine/extensions/ion-meta/bench-gate'

const BENCH = '/tmp/ion-bench-fixture/integration/project-josh'
const MEMBER = '/tmp/ion-bench-fixture/worktrees/project-a3f1'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-benchgate-'))
  process.env.ION_BENCH_TEST_HOME = home
  mkdirSync(join(home, '.ion'), { recursive: true })
  writeFileSync(
    join(home, '.ion', 'integration-workspaces.json'),
    JSON.stringify({ version: 1, workspaces: [{ repoPath: '/repo', sourceBranch: 'josh', benchPath: BENCH }] }),
  )
  _resetBenchCacheForTests()
})

afterEach(() => {
  delete process.env.ION_BENCH_TEST_HOME
  rmSync(home, { recursive: true, force: true })
  _resetBenchCacheForTests()
})

describe('isBenchDirectory', () => {
  it('recognises a bench and its subdirectories', () => {
    expect(isBenchDirectory(BENCH)).toBe(true)
    expect(isBenchDirectory(`${BENCH}/desktop/src`)).toBe(true)
  })

  it('does not treat a member worktree or an unrelated path as a bench', () => {
    expect(isBenchDirectory(MEMBER)).toBe(false)
    expect(isBenchDirectory('/repo')).toBe(false)
    expect(isBenchDirectory('')).toBe(false)
  })

  // A sibling directory whose name merely starts with the bench path must not
  // match -- prefix comparison without the separator would be a real bug.
  it('does not match a sibling with a shared prefix', () => {
    expect(isBenchDirectory(`${BENCH}-other`)).toBe(false)
  })
})

describe('extractGitSubcommands', () => {
  it('finds the subcommand in the shapes an agent actually produces', () => {
    expect(extractGitSubcommands('git commit -m "x"')).toEqual(['commit'])
    expect(extractGitSubcommands('cd /somewhere && git push origin HEAD')).toEqual(['push'])
    expect(extractGitSubcommands('git -C /repo commit -m "x"')).toEqual(['commit'])
    expect(extractGitSubcommands('git -c user.name=X commit -m "y"')).toEqual(['commit'])
    expect(extractGitSubcommands('/usr/bin/git status')).toEqual(['status'])
  })

  it('finds every git invocation in a chained command', () => {
    expect(extractGitSubcommands('git add -A && git commit -m "x"')).toEqual(['add', 'commit'])
  })

  it('returns nothing for a command with no git call', () => {
    expect(extractGitSubcommands('npm run build')).toEqual([])
  })
})

describe('gateBenchCommand', () => {
  // The core refusal. Each of these would be destroyed or published by the
  // next rebuild.
  it.each([
    'git commit -m "fix"',
    'git push origin HEAD',
    'git merge other',
    'git rebase josh',
    'git cherry-pick abc123',
    'git reset --hard HEAD~1',
    'git branch -D wt/a',
    'git checkout -b something',
    'git stash',
    'git add -A && git commit -m "fix"',
  ])('refuses %s inside a bench', (command) => {
    const decision = gateBenchCommand(command, BENCH)

    expect(decision.block).toBe(true)
    expect(decision.reason).toMatch(/integration bench/i)
    // The refusal must say what to do instead, or the agent will simply retry.
    expect(decision.reason).toMatch(/member worktree/i)
  })

  // Over-blocking would defeat the bench's purpose: it exists to build and test.
  it.each([
    'git status',
    'git log --oneline -5',
    'git diff HEAD',
    'git show abc123',
    'make build',
    'npm test',
    './scripts/run.sh',
  ])('allows %s inside a bench', (command) => {
    expect(gateBenchCommand(command, BENCH).block).toBe(false)
  })

  it('allows every git write OUTSIDE a bench', () => {
    expect(gateBenchCommand('git commit -m "fix"', MEMBER).block).toBe(false)
    expect(gateBenchCommand('git push', '/repo').block).toBe(false)
  })

  it('applies inside a bench subdirectory, not just its root', () => {
    expect(gateBenchCommand('git commit -m "x"', `${BENCH}/desktop`).block).toBe(true)
  })

  // Fail OPEN when bench state is unknown: a false refusal would block
  // legitimate commits in an ordinary worktree, which is worse than missing the
  // guard until the file is readable.
  it('fails open when the workspace file is missing or corrupt', () => {
    rmSync(join(home, '.ion', 'integration-workspaces.json'))
    _resetBenchCacheForTests()
    expect(gateBenchCommand('git commit -m "x"', BENCH).block).toBe(false)

    writeFileSync(join(home, '.ion', 'integration-workspaces.json'), 'not json{')
    _resetBenchCacheForTests()
    expect(gateBenchCommand('git commit -m "x"', BENCH).block).toBe(false)
  })
})
