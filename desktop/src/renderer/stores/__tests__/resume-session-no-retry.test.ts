/**
 * resumeSession — history load on restore of an existing conversation.
 *
 * Regression pin for a 6-second restore stall. The old code wrapped
 * `loadSession` in a 3-attempt loop with `2000 * (attempt + 1)` backoff and
 * retried whenever `history.length === 0`. An empty history is the normal
 * answer for a brand-new conversation, so restoring one slept 2s + 4s before
 * the tab appeared — and because useTabRestoration awaits resumeSession for the
 * boot-active tab, that 6s landed in front of the ENTIRE restore sequence.
 * Observed on a live machine: the boot-active tab's `load_session` fired at
 * 23:40:17.74 and restore only began at 23:40:23.75.
 *
 * loadSkeletonMessages already carries the fix and the reasoning ("No retries —
 * the engine is already running and the files are on disk"); this is the sibling
 * path that kept the ladder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Full mock (no importOriginal): the real module constructs an Audio() at
// import time, which node without jsdom lacks.
vi.mock('../session-store-helpers', () => ({
  nextMsgId: (() => {
    let n = 0
    return () => `hist-${++n}`
  })(),
  makeLocalTab: () => ({ id: 'local' }),
  initialPermissionMode: () => 'auto',
}))
vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ tabGroupMode: 'auto', tabGroups: [] }) },
}))

import { createResumeSlice } from '../slices/resume-slice'
import type { State } from '../session-store-types'

const mockLoadSession = vi.fn()
const mockCreateTab = vi.fn()
const mockSetPermissionMode = vi.fn()
const mockGitWorktreeRegistration = vi.fn()

/** Minimal store harness: the real slice over a mutable fake state. */
function makeHarness() {
  let state = {
    tabs: [],
    conversationPanes: new Map(),
    staticInfo: { homePath: '/Users/example' },
  } as unknown as State
  const get = () => state
  const set = (updater: unknown) => {
    const patch = typeof updater === 'function' ? (updater as (s: State) => Partial<State>)(state) : (updater as Partial<State>)
    state = { ...state, ...patch }
  }
  const slice = createResumeSlice(set as never, get as never)
  return {
    resume: () => slice.resumeSession!('conv-1', 'A title', '/repo'),
    state: () => state,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  mockLoadSession.mockReset()
  mockCreateTab.mockReset().mockResolvedValue({ tabId: 'tab-1' })
  mockSetPermissionMode.mockReset()
  mockGitWorktreeRegistration.mockReset().mockResolvedValue({ registration: null })
  ;(globalThis as { window?: unknown }).window = {
    ...(globalThis as { window?: object }).window,
    ion: {
      loadSession: mockLoadSession,
      createTab: mockCreateTab,
      setPermissionMode: mockSetPermissionMode,
      gitWorktreeRegistration: mockGitWorktreeRegistration,
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('resumeSession', () => {
  it('REGRESSION: an empty history is accepted on the first call, with no retry and no timer', async () => {
    // A brand-new conversation: nothing persisted yet.
    mockLoadSession.mockResolvedValue([])

    const h = makeHarness()
    // Real timers are NOT advanced. On the unfixed code this promise cannot
    // settle: it awaits a 2000ms setTimeout that only a timer advance releases,
    // so the await itself is the assertion.
    await h.resume()

    expect(mockLoadSession).toHaveBeenCalledTimes(1)
    // No pending timer was scheduled — the ladder is gone, not merely shortened.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('repairs worktree identity before resumed tab renders', async () => {
    mockLoadSession.mockResolvedValue([])
    mockGitWorktreeRegistration.mockResolvedValue({ registration: {
      repoPath: '/repo', branchName: 'wt/feature', sourceBranch: 'main', title: null,
    } })

    const h = makeHarness()
    await h.resume()

    expect(h.state().tabs[0].worktree).toEqual({
      worktreePath: '/repo',
      branchName: 'wt/feature',
      sourceBranch: 'main',
      repoPath: '/repo',
    })
  })

  it('loads a non-empty history in one call', async () => {
    mockLoadSession.mockResolvedValue([
      { role: 'user', content: 'first prompt' },
      { role: 'assistant', content: 'first answer' },
    ])

    const h = makeHarness()
    await h.resume()

    expect(mockLoadSession).toHaveBeenCalledTimes(1)
    const pane = h.state().conversationPanes.get('tab-1')
    expect(pane?.instances[0].messages.map((m) => m.content)).toEqual([
      'first prompt',
      'first answer',
    ])
  })

  it('a thrown loadSession still produces a usable tab, without retrying', async () => {
    mockLoadSession.mockRejectedValue(new Error('engine socket closed'))

    const h = makeHarness()
    await h.resume()

    // One attempt only: a throw is reported, not retried.
    expect(mockLoadSession).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    // The tab still exists so the conversation is openable.
    expect(h.state().tabs).toHaveLength(1)
    expect(h.state().conversationPanes.get('tab-1')).toBeDefined()
  })
})
