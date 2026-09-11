// @vitest-environment jsdom
/**
 * useActiveGitRepo must itself probe the active tab's directory.
 *
 * Regression test: before this fix, `useActiveGitRepo` only read
 * `useRepoState` passively. Nothing else subscribes to a directory until the
 * Git surface (GitPanelRepoSection) or a Diff surface mounts — but both of
 * those only mount once the Git tab/button is already showing, which itself
 * depends on `useActiveGitRepo().isRepo`. A brand-new tab could never learn
 * its directory was a repo, so the Git tab could never appear. This test
 * fails on the unfixed hook (no subscribe call, `isRepo` never flips to
 * true) and passes once the hook subscribes on its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ACTIVE_TAB_ID = 'tab-1'
const DIRECTORY = '/Users/josh/.ion/worktrees/ion-8a964cad'

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { activeTabId: string; tabs: Array<{ id: string; workingDirectory: string }> }) => unknown) =>
      selector({ activeTabId: ACTIVE_TAB_ID, tabs: [{ id: ACTIVE_TAB_ID, workingDirectory: DIRECTORY }] }),
    { getState: () => ({ activeTabId: ACTIVE_TAB_ID }) },
  ),
}))

import { useActiveGitRepo } from '../useActiveGitRepo'

const gitSnapshot = {
  repoPath: DIRECTORY,
  isGitRepo: true,
  head: { branch: 'main', detached: false, sha: 'abc123' },
  upstream: { name: null, ahead: 0, behind: 0 },
  mergeState: 'none' as const,
  groups: { index: [], workingTree: [], untracked: [], merge: [] },
  revision: 1,
  watcherIgnored: false,
}

const gitSubscribeMock = vi.fn().mockResolvedValue({ snapshot: gitSnapshot })
const gitUnsubscribeMock = vi.fn().mockResolvedValue(undefined)
const gitRefreshMock = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  gitSubscribeMock.mockClear()
  gitUnsubscribeMock.mockClear()
  gitRefreshMock.mockClear()
  ;(window as unknown as { ion: unknown }).ion = {
    gitSubscribe: gitSubscribeMock,
    gitUnsubscribe: gitUnsubscribeMock,
    gitRefresh: gitRefreshMock,
    onGitEvent: vi.fn(() => () => undefined),
  }
})

let latest: ReturnType<typeof useActiveGitRepo> | undefined

function Probe(): null {
  latest = useActiveGitRepo()
  return null
}

function mount(): { unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<Probe />)
  })
  return {
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

describe('useActiveGitRepo', () => {
  it('subscribes to the active tab directory on its own, without a Git surface mounted', async () => {
    const h = mount()

    // The probe fires without any GitPanel/DiffSurface consumer present.
    expect(gitSubscribeMock).toHaveBeenCalledWith(DIRECTORY)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latest?.isRepo).toBe(true)
    h.unmount()
  })
})
