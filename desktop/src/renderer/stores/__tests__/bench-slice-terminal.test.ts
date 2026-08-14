/**
 * Bench slice — the ONE dedicated terminal per bench.
 *
 * ── What is under test ──────────────────────────────────────────────────────
 * Development in a bench is shell work, and the generic new-terminal path stacks
 * a fresh tab per press. `openBenchTerminal` must always land on the SAME tab
 * for a given bench, without storing a tab id anywhere: identity is derived from
 * state the tab already persists (`isTerminalOnly`, `workingDirectory`,
 * `customTitle`), which is what makes it survive a restart and need no
 * reconciliation when the operator closes the tab.
 *
 * Regression direction: replacing the action's body with a plain
 * `createTerminalTab(ws.benchPath)` turns the "same tab twice" test red -- the
 * second press returns a different id and creates a second tab.
 *
 * `ensureBenchDirectory` is pinned here too. `openBenchConversation` previously
 * checked only `lastBuiltAt === 0`, so a bench whose directory was removed out
 * from under Ion (deleted by hand, pruned, wiped `~/.ion/integration`) kept its
 * build timestamp and the conversation opened on a dead path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { createBenchSlice } from '../slices/bench-slice'
import type { State } from '../session-store-types'
import type { IntegrationWorkspace } from '../../../shared/types'
import { benchTerminalTitle } from '../../../shared/worktree-conversations'

const REPO = '/Users/test/project'
const BRANCH = 'josh'
const BENCH_PATH = '/Users/test/.ion/integration/project-josh'
const TITLE = benchTerminalTitle(BRANCH)

/** A tab as the store holds it, reduced to the fields this slice reads. */
interface Tab {
  id: string
  title: string
  customTitle: string | null
  status: string
  workingDirectory: string
  isTerminalOnly?: boolean
  tabRole?: 'bench-conversation' | 'conflict-auto-fix' | 'verification-analysis' | null
}

function tab(over: Partial<Tab> & { id: string }): Tab {
  return {
    title: 'New Terminal',
    customTitle: null,
    status: 'idle',
    workingDirectory: BENCH_PATH,
    isTerminalOnly: true,
    ...over,
  }
}

function workspace(over: Partial<IntegrationWorkspace> = {}): IntegrationWorkspace {
  return {
    repoPath: REPO,
    sourceBranch: BRANCH,
    benchPath: BENCH_PATH,
    benchBranch: 'ion/bench/josh',
    members: [],
    baseSha: 'base1234',
    lastBuiltAt: Date.now(),
    ...over,
  }
}

interface HarnessOptions {
  workspaces?: IntegrationWorkspace[]
  tabs?: Tab[]
  /** Whether the bench directory is present on disk. */
  exists?: boolean
  rebuildOk?: boolean
}

/**
 * Minimal store harness, in the style of `bench-slice-retired.test.ts`: the
 * slice only needs `set`, `get`, and the state it touches, and a full store
 * would obscure which state the action actually writes.
 *
 * `createTerminalTab` and `renameTab` live in other slices, so they are stubbed
 * with the observable part of their real behaviour -- appending a terminal-only
 * tab, and writing `customTitle` -- because the identity rule is derived from
 * exactly those two effects.
 */
function harness(opts: HarnessOptions = {}) {
  let nextId = 1
  const createTerminalTab = vi.fn(async (dir?: string) => {
    const id = `term-${nextId++}`
    state.tabs = [...(state.tabs as Tab[]), tab({ id, workingDirectory: dir ?? BENCH_PATH })]
    return id
  })
  const renameTab = vi.fn((tabId: string, customTitle: string | null) => {
    state.tabs = (state.tabs as Tab[]).map((t) => (t.id === tabId ? { ...t, customTitle } : t))
  })
  const selectTab = vi.fn((tabId: string) => { state.activeTabId = tabId })
  const createTabInDirectory = vi.fn(async () => 'conv-1')

  let state: Record<string, unknown> = {
    benchWorkspaces: new Map([[REPO, opts.workspaces ?? [workspace()]]]),
    benchSourceTips: new Map(),
    benchRetired: new Map(),
    tabs: opts.tabs ?? [],
    activeTabId: null,
    createTerminalTab,
    renameTab,
    selectTab,
    createTabInDirectory,
  }
  const set = (fn: (s: Record<string, unknown>) => Record<string, unknown>): void => {
    state = { ...state, ...fn(state) }
  }
  const get = (): Record<string, unknown> => state

  const benchAssemble = vi.fn().mockResolvedValue(
    opts.rebuildOk === false ? { ok: false, error: 'merge conflict' } : { ok: true },
  )
  const fsExists = vi.fn().mockResolvedValue({ exists: opts.exists ?? true })

  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ion: {
      benchAssemble,
      fsExists,
      benchList: vi.fn().mockResolvedValue({ workspaces: opts.workspaces ?? [workspace()], tips: {} }),
      benchRefreshStaleness: vi.fn().mockResolvedValue({ workspace: null }),
    },
  }

  const slice = createBenchSlice(
    set as unknown as Parameters<typeof createBenchSlice>[0],
    get as unknown as Parameters<typeof createBenchSlice>[1],
  ) as Partial<State>

  // The slice reaches its own actions through get(), the way the real store does.
  state = { ...state, ...slice }

  return {
    slice,
    createTerminalTab,
    renameTab,
    selectTab,
    createTabInDirectory,
    benchAssemble,
    fsExists,
    tabs: (): Tab[] => state.tabs as Tab[],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('openBenchTerminal — one tab per bench', () => {
  it('returns the SAME tab on a second press, creating only one', async () => {
    // The regression test. Reverting the action to a plain createTerminalTab
    // makes the second id differ and the mock get called twice.
    const h = harness()

    const first = await h.slice.openBenchTerminal!(REPO, BRANCH)
    const second = await h.slice.openBenchTerminal!(REPO, BRANCH)

    expect(first).toBe(second)
    expect(h.createTerminalTab).toHaveBeenCalledTimes(1)
    expect(h.tabs().filter((t) => t.isTerminalOnly)).toHaveLength(1)
  })

  it('names the tab on creation so the next press can find it', async () => {
    const h = harness()

    const tabId = await h.slice.openBenchTerminal!(REPO, BRANCH)

    expect(h.renameTab).toHaveBeenCalledWith(tabId, TITLE)
    expect(h.tabs().find((t) => t.id === tabId)!.customTitle).toBe(TITLE)
  })

  it('opens the terminal in the bench directory', async () => {
    const h = harness()
    await h.slice.openBenchTerminal!(REPO, BRANCH)
    expect(h.createTerminalTab).toHaveBeenCalledWith(BENCH_PATH)
  })

  it('focuses the existing terminal instead of creating another', async () => {
    const h = harness({ tabs: [tab({ id: 'existing', customTitle: TITLE })] })

    const tabId = await h.slice.openBenchTerminal!(REPO, BRANCH)

    expect(tabId).toBe('existing')
    expect(h.selectTab).toHaveBeenCalledWith('existing')
    expect(h.createTerminalTab).not.toHaveBeenCalled()
  })

  it('survives a restart: focuses a restored terminal by its persisted state', async () => {
    // Nothing is stored linking bench to tab, so this is the whole durability
    // story -- a restored tab carries isTerminalOnly + workingDirectory +
    // customTitle, which is exactly the identity rule.
    const h = harness({ tabs: [tab({ id: 'restored', customTitle: TITLE })] })
    expect(await h.slice.openBenchTerminal!(REPO, BRANCH)).toBe('restored')
    expect(h.createTerminalTab).not.toHaveBeenCalled()
  })

  it('adopts and names an untitled terminal already in the bench', async () => {
    // Otherwise Ion opens a second shell beside the operator's, in the same
    // directory, for the same purpose.
    const h = harness({ tabs: [tab({ id: 'stray' })] })

    const tabId = await h.slice.openBenchTerminal!(REPO, BRANCH)

    expect(tabId).toBe('stray')
    expect(h.createTerminalTab).not.toHaveBeenCalled()
    expect(h.renameTab).toHaveBeenCalledWith('stray', TITLE)
  })

  it('never overwrites a title the operator chose', async () => {
    const h = harness({ tabs: [tab({ id: 'mine', customTitle: 'Build shell' })] })

    const tabId = await h.slice.openBenchTerminal!(REPO, BRANCH)

    expect(tabId).toBe('mine')
    expect(h.renameTab).not.toHaveBeenCalled()
    expect(h.tabs()[0].customTitle).toBe('Build shell')
  })

  it('ignores a conversation open in the bench directory', async () => {
    // A conversation is not a shell. Focusing one here would answer the wrong
    // question, and it is the defect the collector's terminal skip mirrors.
    const h = harness({ tabs: [tab({ id: 'talk', isTerminalOnly: false, customTitle: TITLE })] })

    const tabId = await h.slice.openBenchTerminal!(REPO, BRANCH)

    expect(tabId).not.toBe('talk')
    expect(h.createTerminalTab).toHaveBeenCalledTimes(1)
  })

  it('ignores a terminal in a different directory', async () => {
    const h = harness({ tabs: [tab({ id: 'elsewhere', workingDirectory: '/somewhere/else', customTitle: TITLE })] })

    await h.slice.openBenchTerminal!(REPO, BRANCH)

    expect(h.createTerminalTab).toHaveBeenCalledWith(BENCH_PATH)
  })

  it('keeps each bench on its own terminal', async () => {
    const other = workspace({
      sourceBranch: 'main',
      benchPath: '/Users/test/.ion/integration/project-main',
      benchBranch: 'ion/bench/main',
    })
    const h = harness({ workspaces: [workspace(), other] })

    const a = await h.slice.openBenchTerminal!(REPO, BRANCH)
    const b = await h.slice.openBenchTerminal!(REPO, 'main')

    expect(a).not.toBe(b)
    expect(h.createTerminalTab).toHaveBeenCalledTimes(2)
  })
})

describe('openBenchTerminal — the directory has to exist first', () => {
  it('builds the bench when it has never been built', async () => {
    const h = harness({ workspaces: [workspace({ lastBuiltAt: 0 })] })

    await h.slice.openBenchTerminal!(REPO, BRANCH)

    expect(h.benchAssemble).toHaveBeenCalledWith(REPO, BRANCH)
    expect(h.createTerminalTab).toHaveBeenCalledTimes(1)
  })

  it('does not waste an fsExists round trip on a never-built bench', async () => {
    const h = harness({ workspaces: [workspace({ lastBuiltAt: 0 })] })
    await h.slice.openBenchTerminal!(REPO, BRANCH)
    expect(h.fsExists).not.toHaveBeenCalled()
  })

  it('rebuilds when the directory was removed behind Ion', async () => {
    // RED under the old lastBuiltAt-only check: the record keeps its build
    // timestamp, so the shell opened on a path that is not there.
    const h = harness({ exists: false })

    await h.slice.openBenchTerminal!(REPO, BRANCH)

    expect(h.fsExists).toHaveBeenCalledWith(BENCH_PATH)
    expect(h.benchAssemble).toHaveBeenCalledWith(REPO, BRANCH)
  })

  it('does not rebuild a built bench that is present', async () => {
    const h = harness({ exists: true })
    await h.slice.openBenchTerminal!(REPO, BRANCH)
    expect(h.benchAssemble).not.toHaveBeenCalled()
  })

  it('creates nothing when the build fails', async () => {
    // A terminal whose cwd does not exist is the defect, not a fallback.
    const h = harness({ workspaces: [workspace({ lastBuiltAt: 0 })], rebuildOk: false })

    expect(await h.slice.openBenchTerminal!(REPO, BRANCH)).toBeNull()
    expect(h.createTerminalTab).not.toHaveBeenCalled()
  })

  it('skips the build entirely when the terminal already exists', async () => {
    // The tab is proof the directory was there; re-checking would cost an IPC
    // round trip on the common path.
    const h = harness({ tabs: [tab({ id: 'existing', customTitle: TITLE })] })

    await h.slice.openBenchTerminal!(REPO, BRANCH)

    expect(h.fsExists).not.toHaveBeenCalled()
    expect(h.benchAssemble).not.toHaveBeenCalled()
  })

  it('returns null for an unknown source branch', async () => {
    const h = harness()
    expect(await h.slice.openBenchTerminal!(REPO, 'no-such-branch')).toBeNull()
    expect(h.createTerminalTab).not.toHaveBeenCalled()
  })

  it('returns null for a repo with no benches at all', async () => {
    const h = harness({ workspaces: [] })
    expect(await h.slice.openBenchTerminal!(REPO, BRANCH)).toBeNull()
  })
})

describe('openBenchConversation — the same existence guard', () => {
  it('rebuilds when the bench directory was removed behind Ion', async () => {
    // RED before ensureBenchDirectory was shared: this path checked only
    // lastBuiltAt, so the conversation opened on a dead path.
    const h = harness({ exists: false })

    await h.slice.openBenchConversation!(REPO, BRANCH)

    expect(h.fsExists).toHaveBeenCalledWith(BENCH_PATH)
    expect(h.benchAssemble).toHaveBeenCalledWith(REPO, BRANCH)
    expect(h.createTabInDirectory).toHaveBeenCalledWith(BENCH_PATH, false, true)
  })

  it('opens nothing when that rebuild fails', async () => {
    const h = harness({ exists: false, rebuildOk: false })

    expect(await h.slice.openBenchConversation!(REPO, BRANCH)).toBeNull()
    expect(h.createTabInDirectory).not.toHaveBeenCalled()
  })

  it('focuses a lone auto-fix instead of creating a persistent conversation', async () => {
    const h = harness({ tabs: [tab({ id: 'fix', isTerminalOnly: false, tabRole: 'conflict-auto-fix' })] })

    expect(await h.slice.openBenchConversation!(REPO, BRANCH)).toBe('fix')
    expect(h.selectTab).toHaveBeenCalledWith('fix')
    expect(h.createTabInDirectory).not.toHaveBeenCalled()
  })

  it('cycles persistent and auto-fix bench conversations with wraparound', async () => {
    const h = harness({ tabs: [
      tab({ id: 'talk', isTerminalOnly: false, tabRole: 'bench-conversation' }),
      tab({ id: 'fix', isTerminalOnly: false, tabRole: 'conflict-auto-fix' }),
    ] })

    expect(await h.slice.openBenchConversation!(REPO, BRANCH)).toBe('talk')
    // The harness mirrors selectTab's active-tab effect so next press rotates.
    expect(await h.slice.openBenchConversation!(REPO, BRANCH)).toBe('fix')
    expect(await h.slice.openBenchConversation!(REPO, BRANCH)).toBe('talk')
    expect(h.createTabInDirectory).not.toHaveBeenCalled()
  })

  it('never focuses the bench terminal as if it were a conversation', async () => {
    // The rotation reads collectDirConversations, which skips terminals. Without
    // that skip, "open a conversation in the bench" lands the operator in a
    // shell instead of creating the conversation they asked for.
    const h = harness({ tabs: [tab({ id: 'shell', customTitle: TITLE })] })

    const tabId = await h.slice.openBenchConversation!(REPO, BRANCH)

    expect(tabId).toBe('conv-1')
    expect(h.selectTab).not.toHaveBeenCalled()
    expect(h.createTabInDirectory).toHaveBeenCalledWith(BENCH_PATH, false, true)
  })
})
