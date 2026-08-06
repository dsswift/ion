// @vitest-environment jsdom
/**
 * finishWorktreeTab — land the work, then retire the worktree and close
 * everything living in it.
 *
 * ── The two defects these pin ───────────────────────────────────────────────
 * 1. The action ended in `closeTab(tabId)`: its OWN tab only. Every sibling
 *    conversation in the same worktree was left pointed at a directory the
 *    retire had just deleted — the same defect the retire path had, in a second
 *    place. AGENTS.md § "When fixing one instance of a bug, search the entire
 *    codebase for the same pattern" is why it is fixed here too.
 * 2. Nothing checked whether that work was still running. `closeTab` refuses a
 *    busy tab and has no `force`, so the close would silently fail AFTER the
 *    land and the removal — leaving the operator with merged work, a
 *    half-retired worktree, and a live agent in a deleted directory.
 *
 * The pre-flight is therefore FIRST, before the land: a refusal after the merge
 * cannot be undone, so the check has to happen while nothing has been touched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const REPO = '/Users/test/project'
const WORKTREE = '/Users/test/.ion/worktrees/project-a3f1'
const BENCH = '/Users/test/.ion/integration/project-josh'

const mockPrefs = {
  worktreeCompletionStrategy: 'merge-ff',
  worktreeBranchDefaults: {} as Record<string, string>,
  setWorktreeBranchDefault: vi.fn(),
  gitOpsMode: 'worktree',
}

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => mockPrefs },
  getEffectiveTabGroups: () => [],
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

const ion = {
  gitWorktreeMerge: vi.fn(),
  gitWorktreePush: vi.fn(),
  gitWorktreeRetire: vi.fn(),
  gitWorktreeRetirePreview: vi.fn(),
  relocateTabSession: vi.fn(),
  openExternal: vi.fn(),
}

import { createWorktreeSlice } from '../slices/worktree-slice'

/** A pane whose instance is mid-run — what the guard blocks on. */
const runningPane = { instances: [{ id: 'main', statusFields: { state: 'running' }, agentStates: [] }] }
const idlePane = { instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [] }] }

function tab(over: Record<string, unknown> = {}) {
  return {
    id: 'tab-1',
    title: 'New Tab',
    customTitle: null,
    workingDirectory: WORKTREE,
    conversationId: null,
    worktree: { worktreePath: WORKTREE, branchName: 'wt/abc', sourceBranch: 'josh', repoPath: REPO },
    ...over,
  }
}

function harness(tabs: Array<Record<string, unknown>>, panes: Map<string, unknown> = new Map()) {
  const state: any = {
    tabs,
    conversationPanes: panes,
    closeIntent: null,
    closeTab: vi.fn((id: string) => {
      // Mirrors the real guard: a busy tab is left in place.
      const pane = state.conversationPanes.get(id) as
        { instances?: Array<{ statusFields?: { state?: string } }> } | undefined
      const busy = (pane?.instances ?? []).some((i) => i.statusFields?.state === 'running')
      if (busy) return
      state.tabs = state.tabs.filter((t: { id: string }) => t.id !== id)
    }),
  }
  const set = (updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  }
  const get = () => state
  Object.assign(state, createWorktreeSlice(set, get))
  return { state }
}

/** Every system message appended to the tab's active instance. */
function systemMessages(state: any, tabId = 'tab-1'): string[] {
  const pane = state.conversationPanes.get(tabId)
  return (pane?.instances?.[0]?.messages ?? []).map((m: { content: string }) => m.content)
}

/** A pane that can receive system messages, which commitInstance requires. */
function messagePane(over: Record<string, unknown> = {}) {
  return { activeInstanceId: 'main', instances: [{ id: 'main', messages: [], ...over }] }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrefs.worktreeCompletionStrategy = 'merge-ff'
  ;(globalThis as any).window = { ion }
  ion.gitWorktreeMerge.mockResolvedValue({ ok: true })
  ion.gitWorktreePush.mockResolvedValue({ ok: true })
  ion.gitWorktreeRetire.mockResolvedValue({ ok: true, workingDirectory: REPO, prunedBenchPaths: [] })
  ion.gitWorktreeRetirePreview.mockResolvedValue({ prunedBenchPaths: [] })
  ion.relocateTabSession.mockResolvedValue({ ok: true, conversationId: 'conv-1' })
})

describe('finishWorktreeTab — refuses while work is active', () => {
  // THE ordering guarantee. Regression direction: move the pre-flight below the
  // merge and this goes red — the work lands and only then is the close refused.
  it('lands nothing and retires nothing when this conversation is running', async () => {
    const { state } = harness(
      [tab()],
      new Map([['tab-1', { ...messagePane(), ...runningPane, instances: [{ id: 'main', messages: [], statusFields: { state: 'running' }, agentStates: [] }] }]]),
    )

    await state.finishWorktreeTab('tab-1')

    expect(ion.gitWorktreeMerge).not.toHaveBeenCalled()
    expect(ion.gitWorktreeRetire).not.toHaveBeenCalled()
    expect(state.tabs).toHaveLength(1)
  })

  it('refuses when a SIBLING conversation in the worktree is running', async () => {
    const { state } = harness(
      [tab(), tab({ id: 'tab-2', customTitle: 'Sibling work' })],
      new Map<string, unknown>([
        ['tab-1', messagePane()],
        ['tab-2', { ...messagePane(), instances: [{ id: 'main', messages: [], statusFields: { state: 'running' }, agentStates: [] }] }],
      ]),
    )

    await state.finishWorktreeTab('tab-1')

    expect(ion.gitWorktreeMerge).not.toHaveBeenCalled()
    expect(ion.gitWorktreeRetire).not.toHaveBeenCalled()
  })

  it('tells the operator which conversation is active', async () => {
    const { state } = harness(
      [tab(), tab({ id: 'tab-2', customTitle: 'Sibling work' })],
      new Map<string, unknown>([
        ['tab-1', messagePane()],
        ['tab-2', { ...messagePane(), instances: [{ id: 'main', messages: [], statusFields: { state: 'running' }, agentStates: [] }] }],
      ]),
    )

    await state.finishWorktreeTab('tab-1')

    const msgs = systemMessages(state).join('\n')
    expect(msgs).toContain('still has active work')
    expect(msgs).toContain('Sibling work')
  })

  it('refuses the push strategy on the same terms', async () => {
    mockPrefs.worktreeCompletionStrategy = 'pr'
    const { state } = harness(
      [tab()],
      new Map([['tab-1', { ...messagePane(), instances: [{ id: 'main', messages: [], statusFields: { state: 'running' }, agentStates: [] }] }]]),
    )

    await state.finishWorktreeTab('tab-1')

    expect(ion.gitWorktreePush).not.toHaveBeenCalled()
    expect(ion.gitWorktreeRetire).not.toHaveBeenCalled()
  })

  it('proceeds when everything in the worktree is idle', async () => {
    const { state } = harness([tab()], new Map([['tab-1', { ...messagePane(), ...idlePane, instances: [{ id: 'main', messages: [], statusFields: { state: 'idle' }, agentStates: [] }] }]]))

    await state.finishWorktreeTab('tab-1')

    expect(ion.gitWorktreeMerge).toHaveBeenCalled()
    expect(ion.gitWorktreeRetire).toHaveBeenCalled()
  })
})

describe('finishWorktreeTab — closes every occupant', () => {
  // The reported defect, in its second location.
  it('closes sibling conversations in the landed worktree, not just its own tab', async () => {
    const { state } = harness(
      [tab(), tab({ id: 'tab-2' }), tab({ id: 'term', isTerminalOnly: true })],
      new Map<string, unknown>([['tab-1', messagePane()]]),
    )

    await state.finishWorktreeTab('tab-1')

    expect(state.tabs).toHaveLength(0)
    expect(state.closeTab).toHaveBeenCalledTimes(3)
  })

  it('leaves conversations in other directories alone', async () => {
    const { state } = harness(
      [tab(), { ...tab({ id: 'elsewhere' }), workingDirectory: REPO, worktree: null }],
      new Map<string, unknown>([['tab-1', messagePane()]]),
    )

    await state.finishWorktreeTab('tab-1')

    expect(state.tabs.map((t: any) => t.id)).toEqual(['elsewhere'])
  })

  it('closes tabs in a bench the retire pruned', async () => {
    ion.gitWorktreeRetire.mockResolvedValueOnce({
      ok: true, workingDirectory: REPO, prunedBenchPaths: [BENCH],
    })
    const { state } = harness(
      [tab(), { ...tab({ id: 'bench-tab' }), workingDirectory: BENCH, worktree: null }],
      new Map<string, unknown>([['tab-1', messagePane()]]),
    )

    await state.finishWorktreeTab('tab-1')

    expect(state.tabs).toHaveLength(0)
  })

  it('closes nothing when the retire after a successful land is refused', async () => {
    ion.gitWorktreeRetire.mockResolvedValueOnce({ ok: false, error: 'worktree is dirty' })
    const { state } = harness([tab()], new Map<string, unknown>([['tab-1', messagePane()]]))

    await state.finishWorktreeTab('tab-1')

    // The worktree survived, so the conversation stays in it — and the operator
    // is told the land succeeded but the directory was kept.
    expect(state.tabs).toHaveLength(1)
    expect(systemMessages(state).join('\n')).toContain('The worktree was kept')
  })

  it('closes nothing when the merge itself fails', async () => {
    ion.gitWorktreeMerge.mockResolvedValueOnce({ ok: false, hasConflicts: true })
    const { state } = harness([tab()], new Map<string, unknown>([['tab-1', messagePane()]]))

    await state.finishWorktreeTab('tab-1')

    expect(ion.gitWorktreeRetire).not.toHaveBeenCalled()
    expect(state.tabs).toHaveLength(1)
  })
})
