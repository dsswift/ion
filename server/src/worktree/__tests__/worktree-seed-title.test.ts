/**
 * Worktree naming — the seed, and where the decision is made.
 *
 * ── What is under test ──────────────────────────────────────────────────────
 * A worktree's every identifier is a machine string (`ion-a3f1`, `wt/ion-a3f1`,
 * a sha), so it carries the name of the CONVERSATION that started it. That name
 * is generated once, by the tab-titling path, and SEEDED here — this handler
 * never talks to a model. It used to: it called `generateTitle` on the same
 * prompt the renderer had just titled the tab with, so one piece of work got two
 * independently-worded names that drifted from the moment they were written.
 *
 * The DECISION about whether a seed applies lives in the server, against the
 * registry (`store/host-api-git.ts` `gitWorktreeSeedTitle`, pinned by
 * `server/src/store/__tests__/host-api-git-seed-title.test.ts`), because a
 * renderer-side check would read whichever inventory snapshot that window
 * happens to hold and every client would race. This file pins the STORAGE
 * half: a hand-created worktree titled by the operator is recorded with an
 * UNKNOWN source branch, never a guessed one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'


// Per-file HOME redirect: vitest runs test FILES concurrently in one process,
// so a shared env var name would let files clobber each other's registry.

import {
  registerWorktree,
  setWorktreeTitle,
  lookupWorktreeTitle,
  lookupWorktreeRegistration,
  lookupSourceBranch,
  worktreeRegistryFile,
} from '../inventory'

const REPO = '/Users/dev/src/ion'
const WT = '/Users/dev/.ion/worktrees/ion-a3f1'

let home: string

let savedIonDataDir: string | undefined

beforeEach(() => {
  savedIonDataDir = process.env.ION_DATA_DIR
  home = mkdtempSync(join(tmpdir(), 'ion-seed-title-'))
  process.env.ION_DATA_DIR = join(home, '.ion')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (savedIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = savedIonDataDir
})

function readRegistry(): { version: number; entries: any[] } {
  return JSON.parse(readFileSync(worktreeRegistryFile(), 'utf-8'))
}

describe('worktree title storage', () => {
  it('records a title against an existing registration', () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })

    setWorktreeTitle(WT, 'Fix the token expiry check')

    expect(lookupWorktreeTitle(WT)).toBe('Fix the token expiry check')
    // The source branch the lifecycle verbs depend on must survive naming.
    expect(lookupSourceBranch(WT)).toBe('josh')
  })

  it('reports no title for a worktree that has never been named', () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })

    expect(lookupWorktreeTitle(WT)).toBeNull()
  })

  it('replaces a title on a rename', () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    setWorktreeTitle(WT, 'Generated name')

    setWorktreeTitle(WT, 'What it is actually about')

    expect(lookupWorktreeTitle(WT)).toBe('What it is actually about')
    expect(readRegistry().entries.filter((e) => e.worktreePath === WT)).toHaveLength(1)
  })

  // A worktree created by hand on the command line has no registry entry, but
  // it appears in the inventory and deserves a name. Titling it must NOT invent
  // a source branch: a wrong one would make `land` merge into the wrong place.
  it('titles a hand-created worktree with an UNKNOWN source branch', () => {
    setWorktreeTitle('/Users/dev/manual-wt', 'Hand-rolled experiment', { repoPath: REPO })

    expect(lookupWorktreeTitle('/Users/dev/manual-wt')).toBe('Hand-rolled experiment')
    expect(lookupSourceBranch('/Users/dev/manual-wt')).toBeNull()
    expect(lookupWorktreeRegistration('/Users/dev/manual-wt')).toEqual({
      repoPath: REPO,
      branchName: '',
      sourceBranch: null,
      title: 'Hand-rolled experiment',
    })
  })

  // Regression: loadRegistry used to require `typeof sourceBranch === 'string'`,
  // which silently dropped every null-source entry on the next read — losing
  // the title of any hand-created worktree the moment it was written.
  it('survives a round-trip through the registry file with a null source branch', () => {
    setWorktreeTitle('/Users/dev/manual-wt', 'Hand-rolled experiment')

    expect(existsSync(worktreeRegistryFile())).toBe(true)
    // A fresh read (lookup re-reads the file every time) must still see it.
    expect(lookupWorktreeTitle('/Users/dev/manual-wt')).toBe('Hand-rolled experiment')
  })

  // Re-attaching a worktree at the same path re-registers it. The description
  // of what the work is about is still true, so dropping it would un-name the
  // row and force another titling round-trip.
  it('keeps an existing title when the worktree is re-registered', () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    setWorktreeTitle(WT, 'Fix the token expiry check')

    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'main' })

    expect(lookupWorktreeTitle(WT)).toBe('Fix the token expiry check')
    expect(lookupSourceBranch(WT)).toBe('main')
  })

  it('leaves the on-disk file at version 1 so older builds still parse it', () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    setWorktreeTitle(WT, 'Anything')

    expect(readRegistry().version).toBe(1)
  })

  // The `abc` case, at the registration seam: a conversation that already has a
  // name is converted into a worktree, and the worktree is born carrying it
  // rather than a hex slug the operator then has to reconcile against the tab
  // strip.
  it('records a seeded title at registration time', () => {
    registerWorktree({
      worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh',
      title: 'abc',
    })

    expect(lookupWorktreeTitle(WT)).toBe('abc')
    expect(lookupSourceBranch(WT)).toBe('josh')
  })

  it('ignores a whitespace-only seed rather than storing a blank name', () => {
    registerWorktree({
      worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh',
      title: '   ',
    })

    expect(lookupWorktreeTitle(WT)).toBeNull()
  })

  // A seed must never overwrite a name the worktree already carries — the same
  // "written once" rule the seed IPC enforces, at the registration seam. Re-
  // registration happens on re-attach at the same path.
  it('keeps the existing title when a re-registration carries a different seed', () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    setWorktreeTitle(WT, 'What the work is actually about')

    registerWorktree({
      worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh',
      title: 'A newer conversation name',
    })

    expect(lookupWorktreeTitle(WT)).toBe('What the work is actually about')
  })
})
