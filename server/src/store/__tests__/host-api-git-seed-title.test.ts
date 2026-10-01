/**
 * Worktree naming — where the seed decision is made.
 *
 * A worktree's every identifier is a machine string, so it carries the name
 * of the CONVERSATION that started it. That name is generated once, by the
 * tab-titling path, and SEEDED here; this path never talks to a model.
 *
 * The decision table these tests pin:
 *   - registered worktree, no title  → persist, announce
 *   - registered worktree, has title → REFUSED, stored title untouched
 *   - no title, but already prompted in → REFUSED, stays unnamed
 *   - has title, and the seed names it as the one it replaces → swapped
 *   - unregistered directory         → REFUSED
 *   - empty/whitespace seed          → REFUSED
 *   - the operator rename is the ONE path that may replace any existing name
 *
 * Regression direction: dropping the `registration.title` short-circuit turns
 * first-prompt-wins red; leaking it into the rename turns the last test red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const deps = vi.hoisted(() => ({ announceWorktreeTitle: vi.fn(async () => undefined) }))
vi.mock('../../worktree/title-announce', () => ({ announceWorktreeTitle: deps.announceWorktreeTitle }))
vi.mock('../../logger', () => ({ log: vi.fn(), trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { lookupWorktreeTitle, registerWorktree, setWorktreeTitle } from '../../worktree/inventory'
import { gitWorktreeCloseTitleSeed, gitWorktreeSeedTitle, gitWorktreeSetTitle } from '../host-api-git'

const REPO = '/Users/dev/src/ion'
const WT = '/Users/dev/.ion/worktrees/ion-a3f1'

let home: string
let savedIonDataDir: string | undefined

beforeEach(() => {
  savedIonDataDir = process.env.ION_DATA_DIR
  home = mkdtempSync(join(tmpdir(), 'ion-seed-title-'))
  process.env.ION_DATA_DIR = join(home, '.ion')
  deps.announceWorktreeTitle.mockClear()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (savedIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = savedIonDataDir
})

describe('seed-title decision', () => {
  it('records the seed on an untitled registered worktree and announces it', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    expect(await gitWorktreeSeedTitle(WT, 'Fix the token expiry check')).toEqual({ ok: true, title: 'Fix the token expiry check' })
    expect(lookupWorktreeTitle(WT)).toBe('Fix the token expiry check')
    expect(deps.announceWorktreeTitle).toHaveBeenCalledWith(REPO, WT, 'Fix the token expiry check')
  })

  it('trims the seed before storing it', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    expect(await gitWorktreeSeedTitle(WT, '  Fix the token expiry check  ')).toEqual({ ok: true, title: 'Fix the token expiry check' })
    expect(lookupWorktreeTitle(WT)).toBe('Fix the token expiry check')
  })

  it('refuses a second seed, so the first conversation to prompt names the worktree', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    expect(await gitWorktreeSeedTitle(WT, 'What the worktree is for')).toEqual({ ok: true, title: 'What the worktree is for' })
    expect(await gitWorktreeSeedTitle(WT, 'A later conversation about something else')).toEqual({ ok: false, reason: 'already-titled', title: 'What the worktree is for' })
    expect(lookupWorktreeTitle(WT)).toBe('What the worktree is for')
  })

  it('lets a generated title replace the placeholder the same conversation stamped', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    await gitWorktreeSeedTitle(WT, 'the auth middleware rejects valid tok...')
    expect(await gitWorktreeSeedTitle(WT, 'Fix the token expiry check', 'the auth middleware rejects valid tok...')).toEqual({ ok: true, title: 'Fix the token expiry check' })
    expect(lookupWorktreeTitle(WT)).toBe('Fix the token expiry check')
    expect(deps.announceWorktreeTitle).toHaveBeenLastCalledWith(REPO, WT, 'Fix the token expiry check')
  })

  it('refuses a replacement once the operator or another conversation has named the worktree', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    await gitWorktreeSeedTitle(WT, 'the auth middleware rejects valid tok...')
    await gitWorktreeSetTitle({ worktreePath: WT, repoPath: REPO, title: 'Renamed by hand' })
    expect(await gitWorktreeSeedTitle(WT, 'Fix the token expiry check', 'the auth middleware rejects valid tok...')).toEqual({ ok: false, reason: 'already-titled', title: 'Renamed by hand' })
    expect(lookupWorktreeTitle(WT)).toBe('Renamed by hand')
  })

  // The first prompt may name nothing (a slash command). The worktree then
  // stays unnamed: a later conversation is not its first.
  it('refuses a seed once the first prompt left the worktree unnamed', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    expect(await gitWorktreeCloseTitleSeed(WT)).toEqual({ closed: true })
    expect(await gitWorktreeSeedTitle(WT, 'A later conversation about something else')).toEqual({ ok: false, reason: 'not-first-prompt' })
    expect(lookupWorktreeTitle(WT)).toBeNull()
    expect(deps.announceWorktreeTitle).not.toHaveBeenCalled()
    expect(await gitWorktreeCloseTitleSeed(WT)).toEqual({ closed: false })
  })

  it('keeps the naming window closed when the worktree is registered again', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    await gitWorktreeCloseTitleSeed(WT)
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    expect((await gitWorktreeSeedTitle(WT, 'A later conversation')).reason).toBe('not-first-prompt')
  })

  it('refuses a seed for an ordinary project directory', async () => {
    expect(await gitWorktreeSeedTitle(REPO, 'A title from a normal project tab')).toEqual({ ok: false, reason: 'not-a-worktree' })
    expect(deps.announceWorktreeTitle).not.toHaveBeenCalled()
  })

  it('refuses a whitespace-only seed rather than blanking the row', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    expect((await gitWorktreeSeedTitle(WT, '   ')).reason).toBe('empty-input')
    expect(lookupWorktreeTitle(WT)).toBeNull()
  })

  it('applies an operator rename and refuses an empty one', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    setWorktreeTitle(WT, 'Seeded name')
    expect(await gitWorktreeSetTitle({ worktreePath: WT, repoPath: REPO, title: '  Operator knows better  ' })).toEqual({ ok: true, title: 'Operator knows better' })
    expect(lookupWorktreeTitle(WT)).toBe('Operator knows better')
    const refused = await gitWorktreeSetTitle({ worktreePath: WT, repoPath: REPO, title: '   ' })
    expect(refused.ok).toBe(false)
    // The refusal must not have blanked the row.
    expect(lookupWorktreeTitle(WT)).toBe('Operator knows better')
  })

  // The operator rename is the ONE path that may replace an existing name.
  it('lets the operator rename a worktree that a seed already named', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    await gitWorktreeSeedTitle(WT, 'Seeded from the conversation')
    await gitWorktreeSetTitle({ worktreePath: WT, repoPath: REPO, title: 'Renamed by hand' })
    expect(lookupWorktreeTitle(WT)).toBe('Renamed by hand')
  })
})
