/**
 * Bench write-gate tests.
 *
 * ── The regression pin ──────────────────────────────────────────────────────
 * `bench-gate.ts` refuses git HISTORY commands but only ever inspects `Bash`,
 * so `Write` and `Edit` inside a bench succeeded — and were silently destroyed
 * by the next rebuild. The first test here fails on that behaviour.
 *
 * ── The attribution cases ───────────────────────────────────────────────────
 * "Who last touched this file" is not sound: in the real repository that
 * motivated this, `AGENTS.md` was modified by all four enrolled members, so a
 * single-owner answer would be wrong three times out of four. The multi-owner
 * test below is modelled directly on that shape and asserts the gate reports
 * the whole owning set rather than guessing one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let home: string

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => process.env.ION_BW_TEST_HOME || actual.homedir() }
})

import {
  gateBenchWrite, _resetBenchWriteCacheForTests,
} from '../../../../engine/extensions/ion-meta/bench-write-gate'

let root: string
let repo: string
let bench: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function write(file: string): { toolName: string; toolId: string; input: Record<string, unknown> } {
  return { toolName: 'Write', toolId: 't1', input: { file_path: file } }
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

function writeWorkspaces(members: Array<{ worktreePath: string; branchName: string; label: string; pinnedSha: string; enabled?: boolean }>, baseSha: string): void {
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-bw-'))
  home = join(root, 'home')
  repo = join(root, 'repo')
  bench = join(root, 'bench')
  mkdirSync(join(home, '.ion'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  process.env.ION_BW_TEST_HOME = home

  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'dev@example.com'])
  git(repo, ['config', 'user.name', 'Dev'])
  writeFileSync(join(repo, 'shared.md'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  writeFileSync(join(repo, 'solo.ts'), 'export const a = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'base'])

  // The bench is a real worktree so the gate's git calls have somewhere to run.
  git(repo, ['worktree', 'add', '-q', '-b', 'ion/bench/main', bench, 'main'])
})

afterEach(() => {
  delete process.env.ION_BW_TEST_HOME
  rmSync(root, { recursive: true, force: true })
  _resetBenchWriteCacheForTests()
})

describe('gateBenchWrite — the regression pin', () => {
  it('refuses a Write inside a bench (this passes on the unfixed code)', () => {
    writeWorkspaces([], git(repo, ['rev-parse', 'main']).trim())

    const d = gateBenchWrite(write(join(bench, 'solo.ts')), bench)

    expect(d.block).toBe(true)
    expect(d.benchPath).toBe(bench)
    expect(d.reason).toContain('destroyed by the next rebuild')
  })

  it('refuses an Edit inside a bench', () => {
    writeWorkspaces([], git(repo, ['rev-parse', 'main']).trim())
    const d = gateBenchWrite(
      { toolName: 'Edit', toolId: 't1', input: { file_path: join(bench, 'solo.ts') } },
      bench,
    )
    expect(d.block).toBe(true)
  })

  it('refuses a write into a bench even from a cwd outside it', () => {
    // The TARGET decides, not the cwd.
    writeWorkspaces([], git(repo, ['rev-parse', 'main']).trim())
    expect(gateBenchWrite(write(join(bench, 'solo.ts')), repo).block).toBe(true)
  })
})

describe('gateBenchWrite — attribution', () => {
  it('names the single member that owns the file', () => {
    const base = git(repo, ['rev-parse', 'main']).trim()
    const sha = memberCommit('wt/alpha', 'solo.ts', 'export const a = 2\n')
    writeWorkspaces([
      { worktreePath: '/wt/alpha', branchName: 'wt/alpha', label: 'alpha', pinnedSha: sha },
    ], base)

    const d = gateBenchWrite(write(join(bench, 'solo.ts')), bench)

    expect(d.owners).toHaveLength(1)
    expect(d.owners![0].branchName).toBe('wt/alpha')
    expect(d.reason).toContain('integrated from member')
    expect(d.reason).toContain('/wt/alpha')
  })

  // THE multi-owner case — the reason "who last touched it" was rejected.
  it('lists every owner with line ranges when several members touch the file', () => {
    const base = git(repo, ['rev-parse', 'main']).trim()

    const lines = (mut: (a: string[]) => void): string => {
      const a = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
      mut(a)
      return a.join('\n') + '\n'
    }
    const shaA = memberCommit('wt/alpha', 'shared.md', lines((a) => { a[4] = 'alpha edit' }))
    const shaB = memberCommit('wt/beta', 'shared.md', lines((a) => { a[29] = 'beta edit' }))

    writeWorkspaces([
      { worktreePath: '/wt/alpha', branchName: 'wt/alpha', label: 'alpha', pinnedSha: shaA },
      { worktreePath: '/wt/beta', branchName: 'wt/beta', label: 'beta', pinnedSha: shaB },
    ], base)

    const d = gateBenchWrite(write(join(bench, 'shared.md')), bench)

    expect(d.block).toBe(true)
    expect(d.owners).toHaveLength(2)
    // Neither is presented as THE owner …
    expect(d.reason).toContain('2 members change this file')
    // … and each is listed with where it changed, so the agent can choose.
    expect(d.reason).toContain('wt/alpha')
    expect(d.reason).toContain('wt/beta')
    expect(d.owners![0].hunks.length).toBeGreaterThan(0)
    expect(d.owners![1].hunks.length).toBeGreaterThan(0)
    // The two members touched different regions, so the ranges must differ.
    expect(d.owners![0].hunks).not.toEqual(d.owners![1].hunks)
  })

  it('falls back to the base branch when no member touches the file', () => {
    const base = git(repo, ['rev-parse', 'main']).trim()
    const sha = memberCommit('wt/alpha', 'solo.ts', 'export const a = 2\n')
    writeWorkspaces([
      { worktreePath: '/wt/alpha', branchName: 'wt/alpha', label: 'alpha', pinnedSha: sha },
    ], base)

    const d = gateBenchWrite(write(join(bench, 'shared.md')), bench)

    expect(d.block).toBe(true)
    expect(d.owners).toHaveLength(0)
    expect(d.reason).toContain('No enrolled member changes this file')
    expect(d.reason).toContain('main')
  })

  it('ignores a disabled member', () => {
    const base = git(repo, ['rev-parse', 'main']).trim()
    const sha = memberCommit('wt/alpha', 'solo.ts', 'export const a = 2\n')
    writeWorkspaces([
      { worktreePath: '/wt/alpha', branchName: 'wt/alpha', label: 'alpha', pinnedSha: sha, enabled: false },
    ], base)

    const d = gateBenchWrite(write(join(bench, 'solo.ts')), bench)

    expect(d.owners).toHaveLength(0)
  })
})

describe('gateBenchWrite — what must still pass', () => {
  it('allows Bash, so the bench can still build and test', () => {
    writeWorkspaces([], git(repo, ['rev-parse', 'main']).trim())
    const d = gateBenchWrite({ toolName: 'Bash', toolId: 't1', input: { command: 'npm test' } }, bench)
    expect(d.block).toBe(false)
  })

  it('allows read-class tools', () => {
    writeWorkspaces([], git(repo, ['rev-parse', 'main']).trim())
    for (const toolName of ['Read', 'Grep', 'Glob', 'Agent']) {
      expect(gateBenchWrite({ toolName, toolId: 't1', input: { file_path: join(bench, 'x') } }, bench).block).toBe(false)
    }
  })

  it('allows a write in a member worktree', () => {
    writeWorkspaces([], git(repo, ['rev-parse', 'main']).trim())
    expect(gateBenchWrite(write(join(root, 'wt-alpha', 'x.ts')), join(root, 'wt-alpha')).block).toBe(false)
  })

  it('does not treat a prefix-sharing sibling as the bench', () => {
    writeWorkspaces([], git(repo, ['rev-parse', 'main']).trim())
    expect(gateBenchWrite(write(`${bench}-other/x.ts`), `${bench}-other`).block).toBe(false)
  })

  it('fails open when the workspace record is unreadable', () => {
    writeFileSync(join(home, '.ion', 'integration-workspaces.json'), '{ not json')
    _resetBenchWriteCacheForTests()
    expect(gateBenchWrite(write(join(bench, 'solo.ts')), bench).block).toBe(false)
  })

  it('fails open when there is no workspace file at all', () => {
    _resetBenchWriteCacheForTests()
    expect(gateBenchWrite(write(join(bench, 'solo.ts')), bench).block).toBe(false)
  })
})
