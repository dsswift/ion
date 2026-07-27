/**
 * Worktree-gate tests.
 *
 * The property that matters: a conversation running in a worktree cannot write
 * into the base repo it was cut from, or into a sibling worktree belonging to
 * another conversation. Those writes interleave several conversations' work in
 * one dirty tree, and review cannot untangle them afterwards.
 *
 * Over-blocking is as much a defect as under-blocking. The gate is NOT "confine
 * the agent to its cwd" — /tmp, ~/.ion, and unrelated repos must all stay
 * writable, and a conversation that is not in a worktree at all must be
 * completely unaffected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let home: string

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => process.env.ION_WT_TEST_HOME || actual.homedir() }
})

import {
  gateWorktreeWrite, resolveWorktreeContainment, _resetWorktreeCacheForTests,
} from '../../../../engine/extensions/ion-meta/worktree-gate'

const REPO = '/tmp/ion-wt-fixture/project'
const MINE = '/tmp/ion-wt-fixture/worktrees/project-a3372546'
const SIBLING = '/tmp/ion-wt-fixture/worktrees/project-c20cc246'
// Shares a prefix with MINE. The containment check must NOT treat this as
// inside MINE, or writes in an unrelated worktree would be refused.
const PREFIX_TWIN = '/tmp/ion-wt-fixture/worktrees/project-a33725460'
const OTHER_REPO = '/tmp/ion-wt-fixture/unrelated'

function write(file: string): { toolName: string; toolId: string; input: Record<string, unknown> } {
  return { toolName: 'Write', toolId: 't1', input: { file_path: file } }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-wtgate-'))
  process.env.ION_WT_TEST_HOME = home
  mkdirSync(join(home, '.ion'), { recursive: true })
  writeFileSync(
    join(home, '.ion', 'worktree-registry.json'),
    JSON.stringify({
      version: 1,
      entries: [
        { worktreePath: MINE, repoPath: REPO, branchName: 'wt/aaa', sourceBranch: 'josh', createdAt: 1 },
        { worktreePath: SIBLING, repoPath: REPO, branchName: 'wt/bbb', sourceBranch: 'josh', createdAt: 2 },
        { worktreePath: PREFIX_TWIN, repoPath: OTHER_REPO, branchName: 'wt/ccc', sourceBranch: 'main', createdAt: 3 },
      ],
    }),
  )
  _resetWorktreeCacheForTests()
})

afterEach(() => {
  delete process.env.ION_WT_TEST_HOME
  rmSync(home, { recursive: true, force: true })
  _resetWorktreeCacheForTests()
})

describe('gateWorktreeWrite — the writes that must be refused', () => {
  it('blocks a write into the base repo', () => {
    const d = gateWorktreeWrite(write(join(REPO, 'engine/internal/foo.go')), MINE)
    expect(d.block).toBe(true)
    expect(d.targetKind).toBe('base repo')
    // The refusal must name where the agent SHOULD write, or the model cannot act on it.
    expect(d.reason).toContain(MINE)
  })

  it('blocks a write into a sibling worktree of the same repo', () => {
    const d = gateWorktreeWrite(write(join(SIBLING, 'desktop/src/index.ts')), MINE)
    expect(d.block).toBe(true)
    expect(d.targetKind).toBe('sibling worktree')
  })

  it('blocks from a SUBDIRECTORY of the worktree, not just its root', () => {
    const d = gateWorktreeWrite(write(join(REPO, 'a.txt')), join(MINE, 'engine/internal'))
    expect(d.block).toBe(true)
  })

  it('blocks an Edit into the base repo', () => {
    const d = gateWorktreeWrite(
      { toolName: 'Edit', toolId: 't1', input: { file_path: join(REPO, 'x.go') } },
      MINE,
    )
    expect(d.block).toBe(true)
    expect(d.targetKind).toBe('base repo')
  })
})

describe('gateWorktreeWrite — the writes that must pass', () => {
  it('allows a write inside the session own worktree', () => {
    expect(gateWorktreeWrite(write(join(MINE, 'engine/x.go')), MINE).block).toBe(false)
  })

  it('allows a Bash call from inside the session own worktree', () => {
    // Bash is gated on the session cwd (see git-gate's extractTargetPath) rather
    // than a parsed target, because this gate cannot see a `cd` mid-command and
    // guessing would produce false refusals in the operator's own directory.
    expect(
      gateWorktreeWrite({ toolName: 'Bash', toolId: 't1', input: { command: 'touch x' } }, MINE).block,
    ).toBe(false)
    expect(
      gateWorktreeWrite(
        { toolName: 'Bash', toolId: 't1', input: { command: 'touch x' } },
        join(MINE, 'engine'),
      ).block,
    ).toBe(false)
  })

  it('allows a write to the worktree root itself', () => {
    expect(gateWorktreeWrite(write(MINE), MINE).block).toBe(false)
  })

  it('does not treat a prefix-sharing sibling directory as inside the worktree', () => {
    // …/project-a33725460 must not match …/project-a3372546. It belongs to a
    // different repo entirely, so it is neither the base nor a sibling: it
    // passes, and it must not be misread as "inside mine" either.
    const d = gateWorktreeWrite(write(join(PREFIX_TWIN, 'x.ts')), MINE)
    expect(d.block).toBe(false)
  })

  it('allows writes to an unrelated repo', () => {
    expect(gateWorktreeWrite(write(join(OTHER_REPO, 'x.ts')), MINE).block).toBe(false)
  })

  it('allows writes to /tmp and ~/.ion — the gate is not a cwd jail', () => {
    expect(gateWorktreeWrite(write('/tmp/scratch.txt'), MINE).block).toBe(false)
    expect(gateWorktreeWrite(write(join(home, '.ion', 'notes.md')), MINE).block).toBe(false)
  })

  it('passes everything when the cwd is not a registered worktree', () => {
    // An ordinary repo conversation must be completely unaffected, including a
    // session running in the base repo itself.
    expect(gateWorktreeWrite(write(join(REPO, 'x.go')), REPO).block).toBe(false)
    expect(gateWorktreeWrite(write(join(MINE, 'x.go')), REPO).block).toBe(false)
    expect(gateWorktreeWrite(write('/tmp/x'), '/tmp/elsewhere').block).toBe(false)
  })

  it('ignores read-class and dispatch tools', () => {
    for (const toolName of ['Read', 'Grep', 'Glob', 'Agent']) {
      const d = gateWorktreeWrite({ toolName, toolId: 't1', input: { file_path: join(REPO, 'x.go') } }, MINE)
      expect(d.block).toBe(false)
    }
  })

  it('passes when the tool carries no extractable target', () => {
    expect(gateWorktreeWrite({ toolName: 'Write', toolId: 't1', input: {} }, MINE).block).toBe(false)
  })
})

describe('registry handling', () => {
  it('resolves containment with the base repo and only same-repo siblings', () => {
    const c = resolveWorktreeContainment(MINE)
    expect(c).not.toBeNull()
    expect(c!.repoPath).toBe(REPO)
    expect(c!.siblingPaths).toEqual([SIBLING])
    // The other repo's worktree is not a sibling of mine.
    expect(c!.siblingPaths).not.toContain(PREFIX_TWIN)
  })

  it('returns null for a directory in no registered worktree', () => {
    expect(resolveWorktreeContainment(REPO)).toBeNull()
    expect(resolveWorktreeContainment('/tmp/nowhere')).toBeNull()
  })

  it('fails OPEN when the registry is unreadable', () => {
    // A false refusal in the place the operator is working is worse than a
    // briefly missing guard, so a corrupt registry must not block anything.
    writeFileSync(join(home, '.ion', 'worktree-registry.json'), '{ not json')
    _resetWorktreeCacheForTests()
    expect(gateWorktreeWrite(write(join(REPO, 'x.go')), MINE).block).toBe(false)
  })

  it('fails OPEN when the registry does not exist', () => {
    rmSync(join(home, '.ion', 'worktree-registry.json'))
    _resetWorktreeCacheForTests()
    expect(gateWorktreeWrite(write(join(REPO, 'x.go')), MINE).block).toBe(false)
  })

  it('ignores malformed entries without discarding the good ones', () => {
    writeFileSync(
      join(home, '.ion', 'worktree-registry.json'),
      JSON.stringify({
        version: 1,
        entries: [
          null,
          { worktreePath: '', repoPath: REPO },
          { worktreePath: MINE },
          { worktreePath: MINE, repoPath: REPO },
        ],
      }),
    )
    _resetWorktreeCacheForTests()
    expect(gateWorktreeWrite(write(join(REPO, 'x.go')), MINE).block).toBe(true)
  })
})
