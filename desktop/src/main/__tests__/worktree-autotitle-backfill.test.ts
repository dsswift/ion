/**
 * Worktree title backfill — naming the worktrees that predate auto-titling.
 *
 * ── The behavior these pin ──────────────────────────────────────────────────
 * First-prompt titling names NEW worktrees, but worktrees created before the
 * feature keep machine slugs until someone happens to prompt in them. The
 * backfill names them from their unlanded commit subjects on inventory read.
 * Pinned here, per the decision table in autotitle-backfill.ts:
 *   - registered + untitled + has subjects → generates, persists, announces;
 *   - already titled (registry) → no LLM call;
 *   - no unlanded commits → skip (its first prompt will title it);
 *   - mid-operation → skip;
 *   - unregistered → skip (nowhere to store the title);
 *   - a failed/empty generation is NOT retried within the run (the attempted
 *     set), and IS retried after a reset — the restart cadence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let home: string

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TB_TEST_HOME || actual.homedir() }
})

const generateTitle = vi.fn()
vi.mock('../state', () => ({
  engineBridge: { generateTitle: (text: string) => generateTitle(text) },
}))

const announceWorktreeTitle = vi.fn().mockResolvedValue(undefined)
vi.mock('../worktree/title-announce', async () => {
  const actual = await vi.importActual<typeof import('../worktree/title-announce')>('../worktree/title-announce')
  return {
    MAX_TITLE_INPUT_CHARS: actual.MAX_TITLE_INPUT_CHARS,
    announceWorktreeTitle: (...args: unknown[]) => announceWorktreeTitle(...args),
  }
})

import {
  maybeBackfillWorktreeTitles,
  _resetBackfillForTests,
  type BackfillCandidate,
} from '../worktree/autotitle-backfill'
import { registerWorktree, setWorktreeTitle, lookupWorktreeTitle } from '../worktree/inventory'

const REPO = '/repo/proj'
const WT = '/wt/proj-a1'

function candidate(over: Partial<BackfillCandidate> = {}): BackfillCandidate {
  return {
    worktreePath: WT,
    unlandedSubjects: ['feat: add hover tooltips', 'fix: tooltip z-order'],
    ...over,
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-tb-'))
  mkdirSync(join(home, '.ion'), { recursive: true })
  process.env.ION_TB_TEST_HOME = home
  vi.clearAllMocks()
  _resetBackfillForTests()
  registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/a1', sourceBranch: 'main' })
})

afterEach(() => {
  delete process.env.ION_TB_TEST_HOME
  rmSync(home, { recursive: true, force: true })
  _resetBackfillForTests()
})

describe('maybeBackfillWorktreeTitles — the backfill path', () => {
  it('titles a registered, untitled worktree from its commit subjects', async () => {
    generateTitle.mockResolvedValue('Hover tooltips')

    const applied = await maybeBackfillWorktreeTitles(REPO, [candidate()])

    expect(applied).toEqual([{ worktreePath: WT, title: 'Hover tooltips' }])
    // The input is the work itself, newest subject first.
    expect(generateTitle).toHaveBeenCalledWith('feat: add hover tooltips\nfix: tooltip z-order')
    // Persisted durably and announced to every surface.
    expect(lookupWorktreeTitle(WT)).toBe('Hover tooltips')
    expect(announceWorktreeTitle).toHaveBeenCalledWith(REPO, WT, 'Hover tooltips')
  })

  it('makes no LLM call for an already-titled worktree', async () => {
    setWorktreeTitle(WT, 'Existing name')
    await maybeBackfillWorktreeTitles(REPO, [candidate({ title: 'Existing name' })])
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('trusts the REGISTRY over a stale inventory entry', async () => {
    // The entry can lag one poll behind a just-applied title; the registry is
    // the durable guard.
    setWorktreeTitle(WT, 'Just applied')
    await maybeBackfillWorktreeTitles(REPO, [candidate({ title: undefined })])
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('skips a worktree with no unlanded commits', async () => {
    // Nothing to describe: its first prompt will title it, like any fresh
    // worktree.
    await maybeBackfillWorktreeTitles(REPO, [candidate({ unlandedSubjects: [] })])
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('skips a mid-operation worktree', async () => {
    await maybeBackfillWorktreeTitles(REPO, [candidate({ operationState: 'rebasing' })])
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('skips an unregistered worktree', async () => {
    await maybeBackfillWorktreeTitles(REPO, [
      candidate({ worktreePath: '/wt/hand-made' }),
    ])
    expect(generateTitle).not.toHaveBeenCalled()
  })
})

describe('maybeBackfillWorktreeTitles — one attempt per run', () => {
  it('does not retry a failed generation within the run', async () => {
    generateTitle.mockRejectedValue(new Error('engine unreachable'))
    await maybeBackfillWorktreeTitles(REPO, [candidate()])
    expect(generateTitle).toHaveBeenCalledTimes(1)

    // The next inventory poll: no second LLM call.
    await maybeBackfillWorktreeTitles(REPO, [candidate()])
    expect(generateTitle).toHaveBeenCalledTimes(1)
  })

  it('does not retry an empty generation (no titling model) within the run', async () => {
    generateTitle.mockResolvedValue('')
    await maybeBackfillWorktreeTitles(REPO, [candidate()])
    await maybeBackfillWorktreeTitles(REPO, [candidate()])
    expect(generateTitle).toHaveBeenCalledTimes(1)
    expect(lookupWorktreeTitle(WT)).toBeNull()
  })

  it('retries after a reset — the restart cadence', async () => {
    generateTitle.mockRejectedValueOnce(new Error('down'))
    await maybeBackfillWorktreeTitles(REPO, [candidate()])
    expect(lookupWorktreeTitle(WT)).toBeNull()

    _resetBackfillForTests()
    generateTitle.mockResolvedValue('Hover tooltips')
    const applied = await maybeBackfillWorktreeTitles(REPO, [candidate()])
    expect(applied).toHaveLength(1)
    expect(lookupWorktreeTitle(WT)).toBe('Hover tooltips')
  })

  it('one candidate failing never blocks the others', async () => {
    const WT2 = '/wt/proj-b2'
    registerWorktree({ worktreePath: WT2, repoPath: REPO, branchName: 'wt/b2', sourceBranch: 'main' })
    generateTitle
      .mockRejectedValueOnce(new Error('first fails'))
      .mockResolvedValueOnce('Second succeeds')

    const applied = await maybeBackfillWorktreeTitles(REPO, [
      candidate(),
      candidate({ worktreePath: WT2, unlandedSubjects: ['feat: other work'] }),
    ])

    expect(applied).toEqual([{ worktreePath: WT2, title: 'Second succeeds' }])
    expect(lookupWorktreeTitle(WT2)).toBe('Second succeeds')
  })
})
