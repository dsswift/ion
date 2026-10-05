/**
 * releaseEphemeralWorktreeOnClose — what closing a conversation does to the
 * ephemeral worktree it was cut for.
 *
 * Drives the release against the shared worktree-inventory store harness, with
 * the host API mocked: the git half (appraisal inside the discard) is pinned by
 * `worktree/__tests__/ephemeral-worktree.test.ts` against real git.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: () => ({ aiGeneratedTitles: false }) },
}))

vi.mock('../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { harness, ion, resetIon, REPO, WT_A, BENCH, runningPane } from './helpers/worktree-inventory-harness'

const eph = {
  keep: vi.fn(),
  policy: vi.fn(),
}

vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  gitWorktreeInventory: (...args: any[]) => ion.gitWorktreeInventory(...args),
  gitWorktreeRegistration: (...args: any[]) => ion.gitWorktreeRegistration(...args),
  gitWorktreeLandAndRetire: (...args: any[]) => ion.gitWorktreeLandAndRetire(...args),
  gitWorktreeDiscard: (...args: any[]) => ion.gitWorktreeDiscard(...args),
  gitWorktreeRetirePreview: (...args: any[]) => ion.gitWorktreeRetirePreview(...args),
  relocateTabSession: (...args: any[]) => ion.relocateTabSession(...args),
  engineStop: (...args: any[]) => ion.engineStop(...args),
  gitWorktreeKeepEphemeral: (...args: any[]) => eph.keep(...args),
  gitWorktreeEphemeralPolicy: (...args: any[]) => eph.policy(...args),
}))

import { releaseEphemeralWorktreeOnClose, resetEphemeralReleaseForTests } from '../slices/ephemeral-worktree-close'

const OWNER = 'owner-tab'

/** The closed conversation, as the close path hands it over: already out of `tabs`. */
const closed = {
  id: OWNER,
  workingDirectory: WT_A,
  worktree: { worktreePath: WT_A, branchName: 'wt/a3f1', sourceBranch: 'josh', repoPath: REPO },
} as any

function registration(over: Record<string, unknown> = {}) {
  return {
    registration: {
      repoPath: REPO, branchName: 'wt/a3f1', sourceBranch: 'josh', title: null,
      ephemeral: { ownerTabId: OWNER }, ...over,
    },
  }
}

function setOn(state: Record<string, any>) {
  return ((patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)) as any
}

beforeEach(() => {
  resetIon()
  resetEphemeralReleaseForTests()
  ion.gitWorktreeRegistration.mockResolvedValue(registration())
  eph.keep.mockResolvedValue({ ok: true })
  eph.policy.mockResolvedValue({ ephemeralDefault: false, ephemeralMayDiscard: false })
})

describe('releaseEphemeralWorktreeOnClose', () => {
  it('removes a clean ephemeral worktree through Retire\'s discard, refusing on unlanded work', async () => {
    const { state } = harness({ tabs: [{ id: 'term', workingDirectory: WT_A, isTerminalOnly: true }] })

    await releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed)

    expect(ion.gitWorktreeDiscard).toHaveBeenCalledWith({
      repoPath: REPO, worktreePath: WT_A, branchName: 'wt/a3f1', sourceBranch: 'josh', onlyIfSafe: true,
    })
    expect(eph.keep).not.toHaveBeenCalled()
    // Retire's relocation: the terminal left in the deleted directory is closed.
    expect(state.closeTab).toHaveBeenCalledWith('term')
    expect(state.tabs).toHaveLength(0)
    expect(ion.gitWorktreeInventory).toHaveBeenCalledWith(REPO)
  })

  it('keeps an ephemeral worktree with unlanded work and makes it ordinary, saying why', async () => {
    ion.gitWorktreeDiscard.mockResolvedValue({
      ok: false, refusedUnlanded: true, error: 'This worktree has 2 commits not yet landed in josh.',
    })
    const { state } = harness({ tabs: [{ id: 'term', workingDirectory: WT_A, isTerminalOnly: true }] })

    await releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed)

    expect(eph.keep).toHaveBeenCalledWith(WT_A, expect.stringContaining('2 commits not yet landed in josh'))
    expect(eph.keep.mock.calls[0][1]).toContain('kept so nothing is lost')
    expect(state.closeTab).not.toHaveBeenCalled()
  })

  it('lets Retire\'s discard preserve and remove unlanded work only when the project allows it', async () => {
    eph.policy.mockResolvedValue({ ephemeralDefault: true, ephemeralMayDiscard: true })
    const { state } = harness()

    await releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed)

    expect(eph.policy).toHaveBeenCalledWith(REPO)
    expect(ion.gitWorktreeDiscard).toHaveBeenCalledWith(expect.objectContaining({ onlyIfSafe: false }))
  })

  it('removes a landed ephemeral worktree with Retire\'s landed cleanup', async () => {
    ion.gitWorktreeRegistration.mockResolvedValue(registration({ landedAt: 1 }))
    const { state } = harness()

    await releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed)

    expect(ion.gitWorktreeLandAndRetire).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: WT_A }))
    expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
  })

  it('leaves an ordinary worktree untouched', async () => {
    ion.gitWorktreeRegistration.mockResolvedValue(registration({ ephemeral: undefined }))
    const { state } = harness()

    await releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed)

    expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
    expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
    expect(eph.keep).not.toHaveBeenCalled()
  })

  it('leaves the worktree alone when the closed conversation is not its owner', async () => {
    ion.gitWorktreeRegistration.mockResolvedValue(registration({ ephemeral: { ownerTabId: 'someone-else' } }))
    const { state } = harness()

    await releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed)

    expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
    expect(eph.keep).not.toHaveBeenCalled()
  })

  it('does nothing while the owner is still open (its close was refused)', async () => {
    const { state } = harness({ tabs: [{ id: OWNER, workingDirectory: WT_A }] })

    await releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed)

    expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
    expect(eph.keep).not.toHaveBeenCalled()
  })

  it('keeps the worktree as ordinary while another conversation is open in it', async () => {
    const { state } = harness({ tabs: [{ id: 'other', workingDirectory: WT_A }] })

    await releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed)

    expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
    expect(eph.keep).toHaveBeenCalledWith(WT_A, '1 other conversation is still open in it.')
    expect(state.tabs).toHaveLength(1)
  })

  it('keeps the worktree when Retire\'s pre-flight finds active work in a bench it would prune', async () => {
    ion.gitWorktreeRetirePreview.mockResolvedValue({ prunedBenchPaths: [BENCH] })
    const { state } = harness({
      tabs: [{ id: 'bench', workingDirectory: BENCH, customTitle: 'Bench run' } as any],
      panes: new Map([['bench', runningPane]]),
    })

    await releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed)

    expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
    expect(eph.keep).toHaveBeenCalledWith(WT_A, expect.stringContaining('Bench run'))
  })

  it('keeps the worktree when the removal fails for another reason', async () => {
    ion.gitWorktreeDiscard.mockResolvedValue({ ok: false, error: 'git exploded' })
    const { state } = harness()

    await releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed)

    expect(eph.keep).toHaveBeenCalledWith(WT_A, 'Removing it failed: git exploded')
  })

  it('runs one release when the same close is reported twice', async () => {
    const { state } = harness()

    await Promise.all([
      releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed),
      releaseEphemeralWorktreeOnClose(setOn(state), () => state as any, closed),
    ])

    expect(ion.gitWorktreeDiscard).toHaveBeenCalledTimes(1)
  })
})
