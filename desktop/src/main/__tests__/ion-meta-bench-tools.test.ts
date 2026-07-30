/**
 * Bench tools tests — ion_bench_info and ion_bench_locate against real git.
 *
 * ── What these pin ──────────────────────────────────────────────────────────
 * The tools are the PROACTIVE half of bench routing: they answer "what is this
 * bench" and "who owns this file" before an edit is attempted, instead of the
 * write gate teaching the same facts through a refusal. Pinned here:
 *   - info lists the composition (source branch, members, pins, enabled state);
 *   - locate names the single owner with hunks, reports the true multi-owner
 *     SET when two members touch one file (never a guessed single owner — the
 *     same rule as the write gate), and answers "base branch" for a file no
 *     member changes;
 *   - relative paths resolve against the BENCH ROOT (the model reasons in
 *     repo-relative paths regardless of the conversation's subdirectory cwd);
 *   - both answer honestly outside a bench;
 *   - both are planModeSafe (routing decisions are made while planning).
 *
 * Real git fixture, not mocks: attribution IS git behavior (diff of pin vs
 * base), the same reason the bench-write-gate tests use real repos.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let home: string

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => process.env.ION_BT_TEST_HOME || actual.homedir() }
})

import { benchInfoTool, benchLocateTool, isBenchCwd } from '../../../../engine/extensions/ion-meta/tools/bench-tools'
import { _resetBenchWriteCacheForTests } from '../../../../engine/extensions/ion-meta/bench-write-gate'

let root: string
let repo: string
let bench: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** Commit `content` to `file` on a new branch cut from main; return its sha. */
function memberCommit(name: string, file: string, content: string): string {
  git(repo, ['switch', '-q', '-c', name, 'main'])
  writeFileSync(join(repo, file), content)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', `${name} touches ${file}`])
  const sha = git(repo, ['rev-parse', 'HEAD']).trim()
  git(repo, ['switch', '-q', 'main'])
  return sha
}

function writeWorkspaces(
  members: Array<{ worktreePath: string; branchName: string; label: string; pinnedSha: string; enabled?: boolean }>,
  baseSha: string,
): void {
  writeFileSync(
    join(home, '.ion', 'integration-workspaces.json'),
    JSON.stringify({
      version: 1,
      workspaces: [{
        repoPath: repo, sourceBranch: 'main', benchPath: bench,
        benchBranch: 'ion/bench/main', baseSha, lastBuiltAt: 1, members,
      }],
    }),
  )
  _resetBenchWriteCacheForTests()
}

/** Minimal IonContext stand-in: the tools only read ctx.cwd. */
function ctx(cwd: string): never {
  return { cwd } as never
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-bt-'))
  home = join(root, 'home')
  repo = join(root, 'repo')
  bench = join(root, 'bench')
  mkdirSync(join(home, '.ion'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  process.env.ION_BT_TEST_HOME = home

  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'dev@example.com'])
  git(repo, ['config', 'user.name', 'Dev'])
  writeFileSync(join(repo, 'shared.md'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  writeFileSync(join(repo, 'solo.ts'), 'export const a = 1\n')
  writeFileSync(join(repo, 'untouched.ts'), 'export const b = 2\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'base'])

  // The bench is a real worktree so attribution's git calls have somewhere to run.
  git(repo, ['worktree', 'add', '-q', '-b', 'ion/bench/main', bench, 'main'])
})

afterEach(() => {
  delete process.env.ION_BT_TEST_HOME
  rmSync(root, { recursive: true, force: true })
  _resetBenchWriteCacheForTests()
})

describe('ion_bench_info', () => {
  it('describes the bench composition', async () => {
    const base = git(repo, ['rev-parse', 'main']).trim()
    const shaA = memberCommit('wt/alpha', 'solo.ts', 'export const a = 99\n')
    writeWorkspaces([
      { worktreePath: '/wt/alpha', branchName: 'wt/alpha', label: 'alpha', pinnedSha: shaA },
      { worktreePath: '/wt/beta', branchName: 'wt/beta', label: 'beta', pinnedSha: base, enabled: false },
    ], base)

    const result = await benchInfoTool.execute({}, ctx(bench))

    expect(result.content).toContain(bench)
    expect(result.content).toContain('main')
    expect(result.content).toContain('alpha')
    expect(result.content).toContain('/wt/alpha')
    expect(result.content).toContain(shaA.slice(0, 7))
    // Disabled members ARE listed by info (unlike the briefing) — the operator
    // may re-enable them, and "what is enrolled" includes the disabled set —
    // but marked clearly so routing never targets one silently.
    expect(result.content).toContain('DISABLED')
    expect(result.content).toContain('never edit here')
  })

  it('answers honestly outside a bench', async () => {
    writeWorkspaces([], git(repo, ['rev-parse', 'main']).trim())
    const result = await benchInfoTool.execute({}, ctx('/ordinary/project'))
    expect(result.content).toContain('not inside an integration bench')
  })

  it('is planModeSafe', () => {
    expect(benchInfoTool.planModeSafe).toBe(true)
    expect(benchLocateTool.planModeSafe).toBe(true)
  })
})

describe('ion_bench_locate', () => {
  it('names the single owner with its member-worktree destination', async () => {
    const base = git(repo, ['rev-parse', 'main']).trim()
    const shaA = memberCommit('wt/alpha', 'solo.ts', 'export const a = 99\n')
    writeWorkspaces([
      { worktreePath: '/wt/alpha', branchName: 'wt/alpha', label: 'alpha', pinnedSha: shaA },
    ], base)

    const result = await benchLocateTool.execute({ path: 'solo.ts' }, ctx(bench))

    expect(result.content).toContain('alpha')
    expect(result.content).toContain(join('/wt/alpha', 'solo.ts'))
    expect(result.content).toContain('commit it in that worktree')
  })

  it('reports the true multi-owner set with line ranges, never a guess', async () => {
    // Both members edit shared.md in different regions — the AGENTS.md shape
    // that motivated set-based attribution in the write gate.
    const base = git(repo, ['rev-parse', 'main']).trim()
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
    const early = [...lines]; early[2] = 'ALPHA EDIT'
    const late = [...lines]; late[35] = 'BETA EDIT'
    const shaA = memberCommit('wt/alpha', 'shared.md', early.join('\n') + '\n')
    const shaB = memberCommit('wt/beta', 'shared.md', late.join('\n') + '\n')
    writeWorkspaces([
      { worktreePath: '/wt/alpha', branchName: 'wt/alpha', label: 'alpha', pinnedSha: shaA },
      { worktreePath: '/wt/beta', branchName: 'wt/beta', label: 'beta', pinnedSha: shaB },
    ], base)

    const result = await benchLocateTool.execute({ path: 'shared.md' }, ctx(bench))

    expect(result.content).toContain('2 members change')
    expect(result.content).toContain('alpha')
    expect(result.content).toContain('beta')
    expect(result.content).toContain('L3')   // alpha's region
    expect(result.content).toContain('L36')  // beta's region
    expect(result.content).toContain('owns the lines you are changing')
  })

  it('attributes a file no member changes to the base branch', async () => {
    const base = git(repo, ['rev-parse', 'main']).trim()
    const shaA = memberCommit('wt/alpha', 'solo.ts', 'export const a = 99\n')
    writeWorkspaces([
      { worktreePath: '/wt/alpha', branchName: 'wt/alpha', label: 'alpha', pinnedSha: shaA },
    ], base)

    const result = await benchLocateTool.execute({ path: 'untouched.ts' }, ctx(bench))

    expect(result.content).toContain('No enrolled member changes')
    expect(result.content).toContain('base branch `main`')
  })

  it('resolves relative paths against the bench ROOT, not the cwd subdirectory', async () => {
    const base = git(repo, ['rev-parse', 'main']).trim()
    const shaA = memberCommit('wt/alpha', 'solo.ts', 'export const a = 99\n')
    writeWorkspaces([
      { worktreePath: '/wt/alpha', branchName: 'wt/alpha', label: 'alpha', pinnedSha: shaA },
    ], base)

    // cwd deep inside the bench; the repo-relative path must still resolve.
    const sub = join(bench, 'some', 'nested')
    const result = await benchLocateTool.execute({ path: 'solo.ts' }, ctx(sub))

    expect(result.content).toContain('alpha')
  })

  it('answers honestly outside a bench, and errors on an empty path', async () => {
    writeWorkspaces([], git(repo, ['rev-parse', 'main']).trim())
    const outside = await benchLocateTool.execute({ path: 'x.ts' }, ctx('/ordinary/project'))
    expect(outside.content).toContain('not inside an integration bench')

    const empty = await benchLocateTool.execute({ path: '  ' }, ctx(bench))
    expect(empty.isError).toBe(true)
  })
})

describe('isBenchCwd — the suppression predicate', () => {
  it('is true inside the bench and its subdirectories, false elsewhere', () => {
    writeWorkspaces([], git(repo, ['rev-parse', 'main']).trim())
    expect(isBenchCwd(bench)).toBe(true)
    expect(isBenchCwd(join(bench, 'desktop', 'src'))).toBe(true)
    expect(isBenchCwd(repo)).toBe(false)
    expect(isBenchCwd(`${bench}-other`)).toBe(false)
    expect(isBenchCwd('')).toBe(false)
  })
})
