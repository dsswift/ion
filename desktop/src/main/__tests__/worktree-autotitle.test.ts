/**
 * Worktree auto-titling — the decision, and where it is made.
 *
 * ── What is under test ──────────────────────────────────────────────────────
 * A worktree's every identifier is a machine string (`ion-a3f1`, `wt/ion-a3f1`,
 * a sha), so it earns a human title from the first prompt sent inside it. The
 * DECISION about whether a title is needed lives in the main process, against
 * the registry, for two reasons: a renderer-side check would read whichever
 * inventory snapshot that window happens to hold (stale in the ATV mirror,
 * absent in a window that never opened the git panel), and both windows sending
 * on the same tab would each fire an LLM call.
 *
 * So these tests pin the decision table:
 *   - registered worktree, no title  → generate, persist, announce
 *   - registered worktree, has title → NO LLM call at all
 *   - unregistered directory         → NO LLM call at all
 *   - hand-created worktree titled by the operator → recorded with an UNKNOWN
 *     source branch, never a guessed one
 *
 * Regression direction: dropping the `registration.title` short-circuit makes
 * "already titled" fire the LLM and go red; widening the not-a-worktree branch
 * makes an ordinary project directory generate a title it has nowhere to store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Per-file HOME redirect: vitest runs test FILES concurrently in one process,
// so a shared env var name would let files clobber each other's registry.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_WT_AUTOTITLE || actual.homedir() }
})

import {
  registerWorktree,
  setWorktreeTitle,
  lookupWorktreeTitle,
  lookupWorktreeRegistration,
  lookupSourceBranch,
  worktreeRegistryFile,
} from '../worktree/inventory'

const REPO = '/Users/dev/src/ion'
const WT = '/Users/dev/.ion/worktrees/ion-a3f1'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-autotitle-'))
  process.env.ION_TEST_HOME_WT_AUTOTITLE = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.ION_TEST_HOME_WT_AUTOTITLE
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
})

describe('autotitle decision', () => {
  /**
   * The handler under test is registered on ipcMain, so the decision logic is
   * exercised through a captured handler rather than a live Electron process.
   */
  async function loadHandlers() {
    const handlers = new Map<string, (...args: any[]) => any>()
    const generateTitle = vi.fn(async () => 'Fix the token expiry check')

    vi.resetModules()
    vi.doMock('electron', () => ({
      ipcMain: { handle: (channel: string, fn: any) => handlers.set(channel, fn) },
    }))
    vi.doMock('../state', () => ({ engineBridge: { generateTitle } }))
    vi.doMock('../broadcast', () => ({ broadcast: vi.fn() }))
    vi.doMock('../remote/handlers/worktree', () => ({ pushWorktreeState: vi.fn(async () => {}) }))

    const { registerWorktreeIpc } = await import('../ipc/worktree')
    registerWorktreeIpc()
    return { handlers, generateTitle }
  }

  afterEach(() => {
    vi.doUnmock('electron')
    vi.resetModules()
  })

  it('titles an untitled registered worktree from the prompt and persists it', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    const { handlers, generateTitle } = await loadHandlers()

    const result = await handlers.get('ion:git-worktree-autotitle')!(
      {}, { workingDirectory: WT, text: 'the auth middleware rejects valid tokens' },
    )

    expect(generateTitle).toHaveBeenCalledWith('the auth middleware rejects valid tokens')
    expect(result).toEqual({ ok: true, title: 'Fix the token expiry check' })
    expect(lookupWorktreeTitle(WT)).toBe('Fix the token expiry check')
  })

  // The cost guarantee: one titling round-trip per worktree, ever. Every send
  // calls this handler, so without the short-circuit each prompt would pay.
  it('makes NO llm call when the worktree already has a title', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    setWorktreeTitle(WT, 'Already named')
    const { handlers, generateTitle } = await loadHandlers()

    const result = await handlers.get('ion:git-worktree-autotitle')!(
      {}, { workingDirectory: WT, text: 'a later prompt' },
    )

    expect(generateTitle).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, reason: 'already-titled', title: 'Already named' })
    expect(lookupWorktreeTitle(WT)).toBe('Already named')
  })

  it('makes NO llm call for an ordinary project directory', async () => {
    const { handlers, generateTitle } = await loadHandlers()

    const result = await handlers.get('ion:git-worktree-autotitle')!(
      {}, { workingDirectory: REPO, text: 'a prompt in a normal project tab' },
    )

    expect(generateTitle).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, reason: 'not-a-worktree' })
  })

  it('makes NO llm call for empty prompt text', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    const { handlers, generateTitle } = await loadHandlers()

    const result = await handlers.get('ion:git-worktree-autotitle')!(
      {}, { workingDirectory: WT, text: '   ' },
    )

    expect(generateTitle).not.toHaveBeenCalled()
    expect(result.reason).toBe('empty-input')
  })

  // No titling model configured is a legitimate configuration, not an error.
  // The worktree keeps its slug and nothing is written.
  it('records nothing when the engine returns an empty title', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    const { handlers, generateTitle } = await loadHandlers()
    generateTitle.mockResolvedValueOnce('')

    const result = await handlers.get('ion:git-worktree-autotitle')!(
      {}, { workingDirectory: WT, text: 'some prompt' },
    )

    expect(result).toEqual({ ok: false, reason: 'empty-title' })
    expect(lookupWorktreeTitle(WT)).toBeNull()
  })

  it('leaves the worktree unnamed when generation throws, so the next prompt retries', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    const { handlers, generateTitle } = await loadHandlers()
    generateTitle.mockRejectedValueOnce(new Error('engine unreachable'))

    const result = await handlers.get('ion:git-worktree-autotitle')!(
      {}, { workingDirectory: WT, text: 'some prompt' },
    )

    expect(result).toEqual({ ok: false, reason: 'generation-failed' })
    expect(lookupWorktreeTitle(WT)).toBeNull()
  })

  it('applies an operator rename and refuses an empty one', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    setWorktreeTitle(WT, 'Generated name')
    const { handlers } = await loadHandlers()

    const ok = await handlers.get('ion:git-worktree-set-title')!(
      {}, { worktreePath: WT, repoPath: REPO, title: '  Operator knows better  ' },
    )
    expect(ok).toEqual({ ok: true, title: 'Operator knows better' })
    expect(lookupWorktreeTitle(WT)).toBe('Operator knows better')

    const refused = await handlers.get('ion:git-worktree-set-title')!(
      {}, { worktreePath: WT, repoPath: REPO, title: '   ' },
    )
    expect(refused.ok).toBe(false)
    // The refusal must not have blanked the row.
    expect(lookupWorktreeTitle(WT)).toBe('Operator knows better')
  })
})
