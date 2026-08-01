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
 * The DECISION about whether a seed applies lives in the main process, against
 * the registry, because a renderer-side check would read whichever inventory
 * snapshot that window happens to hold (stale in the ATV mirror, absent in a
 * window that never opened the git panel) and both windows would race.
 *
 * So these tests pin the decision table:
 *   - registered worktree, no title  → persist, announce
 *   - registered worktree, has title → REFUSED, stored title untouched
 *   - unregistered directory         → REFUSED
 *   - empty/whitespace seed          → REFUSED
 *   - NO `generateTitle` call on any path
 *   - hand-created worktree titled by the operator → recorded with an UNKNOWN
 *     source branch, never a guessed one
 *
 * Regression direction: reintroducing a `generateTitle` call on this path turns
 * the "never generates" assertions red; dropping the `registration.title`
 * short-circuit turns first-prompt-wins red.
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
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_WT_SEED_TITLE || actual.homedir() }
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
  home = mkdtempSync(join(tmpdir(), 'ion-seed-title-'))
  process.env.ION_TEST_HOME_WT_SEED_TITLE = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.ION_TEST_HOME_WT_SEED_TITLE
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

describe('seed-title decision', () => {
  /**
   * The handler under test is registered on ipcMain, so the decision logic is
   * exercised through a captured handler rather than a live Electron process.
   *
   * `engineBridge.generateTitle` is still mocked — not because this path uses
   * it, but so the tests can assert it is NEVER called. That assertion is the
   * regression guard against reintroducing the second generator this change
   * removed.
   */
  async function loadHandlers() {
    const handlers = new Map<string, (...args: any[]) => any>()
    const generateTitle = vi.fn(async () => 'A generated name')
    const pushWorktreeState = vi.fn(async () => {})
    const broadcast = vi.fn()

    vi.resetModules()
    vi.doMock('electron', () => ({
      ipcMain: { handle: (channel: string, fn: any) => handlers.set(channel, fn) },
    }))
    vi.doMock('../state', () => ({ engineBridge: { generateTitle } }))
    vi.doMock('../broadcast', () => ({ broadcast }))
    vi.doMock('../remote/handlers/worktree', () => ({ pushWorktreeState }))

    const { registerWorktreeIpc } = await import('../ipc/worktree')
    registerWorktreeIpc()
    return { handlers, generateTitle, pushWorktreeState, broadcast }
  }

  afterEach(() => {
    vi.doUnmock('electron')
    vi.resetModules()
  })

  it('records the seed on an untitled registered worktree and announces it', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    const { handlers, generateTitle, broadcast, pushWorktreeState } = await loadHandlers()

    const result = await handlers.get('ion:git-worktree-seed-title')!(
      {}, { worktreePath: WT, title: 'Fix the token expiry check' },
    )

    expect(result).toEqual({ ok: true, title: 'Fix the token expiry check' })
    expect(lookupWorktreeTitle(WT)).toBe('Fix the token expiry check')
    // Nothing on this path may talk to a model.
    expect(generateTitle).not.toHaveBeenCalled()
    // Both renderer windows repaint, and the phone is pushed.
    expect(broadcast).toHaveBeenCalledWith('ion:worktree-titled', {
      repoPath: REPO, worktreePath: WT, title: 'Fix the token expiry check',
    })
    expect(pushWorktreeState).toHaveBeenCalledWith(REPO)
  })

  it('trims the seed before storing it', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    const { handlers } = await loadHandlers()

    const result = await handlers.get('ion:git-worktree-seed-title')!(
      {}, { worktreePath: WT, title: '  Fix the token expiry check  ' },
    )

    expect(result).toEqual({ ok: true, title: 'Fix the token expiry check' })
    expect(lookupWorktreeTitle(WT)).toBe('Fix the token expiry check')
  })

  /**
   * FIRST PROMPT WINS — the topic-stability rule.
   *
   * Several conversations routinely share one worktree, and each of their first
   * sends reaches this handler. A worktree is cut for a topic, and that topic
   * does not change because a second tab was opened in it to chase a bug found
   * along the way. Whichever conversation prompts first names it; every later
   * seed is refused and the stored name is untouched.
   *
   * Regression direction: dropping the `registration.title` guard makes the
   * second seed overwrite the first and turns this red.
   */
  it('refuses a second seed, so the first conversation to prompt names the worktree', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    const { handlers, generateTitle } = await loadHandlers()

    const first = await handlers.get('ion:git-worktree-seed-title')!(
      {}, { worktreePath: WT, title: 'What the worktree is for' },
    )
    const second = await handlers.get('ion:git-worktree-seed-title')!(
      {}, { worktreePath: WT, title: 'A later conversation about something else' },
    )

    expect(first).toEqual({ ok: true, title: 'What the worktree is for' })
    expect(second).toEqual({
      ok: false, reason: 'already-titled', title: 'What the worktree is for',
    })
    expect(lookupWorktreeTitle(WT)).toBe('What the worktree is for')
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('refuses a seed for an ordinary project directory', async () => {
    const { handlers, generateTitle } = await loadHandlers()

    const result = await handlers.get('ion:git-worktree-seed-title')!(
      {}, { worktreePath: REPO, title: 'A title from a normal project tab' },
    )

    expect(result).toEqual({ ok: false, reason: 'not-a-worktree' })
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('refuses a whitespace-only seed rather than blanking the row', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    const { handlers, generateTitle } = await loadHandlers()

    const result = await handlers.get('ion:git-worktree-seed-title')!(
      {}, { worktreePath: WT, title: '   ' },
    )

    expect(result.reason).toBe('empty-input')
    expect(lookupWorktreeTitle(WT)).toBeNull()
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('applies an operator rename and refuses an empty one', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    setWorktreeTitle(WT, 'Seeded name')
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

  // The operator rename is the ONE path that may replace an existing name. The
  // seed's already-titled guard must not have leaked into it.
  it('lets the operator rename a worktree that a seed already named', async () => {
    registerWorktree({ worktreePath: WT, repoPath: REPO, branchName: 'wt/ion-a3f1', sourceBranch: 'josh' })
    const { handlers } = await loadHandlers()

    await handlers.get('ion:git-worktree-seed-title')!(
      {}, { worktreePath: WT, title: 'Seeded from the conversation' },
    )
    await handlers.get('ion:git-worktree-set-title')!(
      {}, { worktreePath: WT, repoPath: REPO, title: 'Renamed by hand' },
    )

    expect(lookupWorktreeTitle(WT)).toBe('Renamed by hand')
  })
})
