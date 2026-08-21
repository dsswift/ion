// @vitest-environment jsdom
/** DiffSurface always follows active conversation checkout. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useSessionStore } from '../../../stores/sessionStore'
import { useGitStore } from '../../../stores/git'
import { useSurfaceStore } from '../surface-store'
import { DiffSurface } from '../tabs/DiffSurface'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const scrollIntoViewMock = vi.fn()

beforeEach(() => {
  scrollIntoViewMock.mockClear()
  Element.prototype.scrollIntoView = scrollIntoViewMock
  vi.stubGlobal('IntersectionObserver', class { observe(): void {} disconnect(): void {} unobserve(): void {} })
  ;(window as unknown as { ion: unknown }).ion = {
    gitSubscribe: vi.fn().mockResolvedValue({ snapshot: null }),
    gitUnsubscribe: vi.fn().mockResolvedValue(undefined),
    gitRefresh: vi.fn().mockResolvedValue(undefined),
    gitDiff: vi.fn().mockResolvedValue({ diff: '', fileName: 'x.ts' }),
    onGitEvent: vi.fn(() => () => undefined),
  }
  useSessionStore.setState({
    activeTabId: 'ion',
    rehydrating: true,
    tabs: [
      { id: 'ion', workingDirectory: '/worktrees/ion', historicalSessionIds: [], bashResults: [], label: 'ion', status: 'idle' },
      { id: 'website', workingDirectory: '/repos/ion-website', historicalSessionIds: [], bashResults: [], label: 'website', status: 'idle' },
    ] as never,
  })
  useGitStore.setState({
    repos: {
      '/worktrees/ion': {
        repoPath: '/worktrees/ion', branch: 'main', revision: 1, files: [],
        groups: { index: [], workingTree: [{ path: 'engine/main.go', staged: false, status: 'modified' }], untracked: [], merge: [] },
      } as never,
      '/repos/ion-website': {
        repoPath: '/repos/ion-website', branch: 'main', revision: 1, files: [],
        groups: { index: [{ path: 'site/index.ts', staged: true, status: 'modified' }], workingTree: [], untracked: [], merge: [] },
      } as never,
    },
  })
  useSurfaceStore.setState({ tabs: [], activeTabId: null, hydrated: true, diffReveal: null })
})

describe('DiffSurface', () => {
  it('uses active checkout after a workspace reveal and follows conversation switch', async () => {
    useSurfaceStore.getState().revealDiffFile({ filePath: 'engine/main.go', staged: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<DiffSurface />))

    expect(container.textContent).toContain('ion')
    expect(container.textContent).not.toContain('workspace repo')
    expect(container.querySelector('section[data-diff-path="engine/main.go"][data-diff-staged="0"]')).not.toBeNull()
    expect((window as unknown as { ion: { gitDiff: ReturnType<typeof vi.fn> } }).ion.gitDiff).toHaveBeenCalledWith('/worktrees/ion', 'engine/main.go', false)

    act(() => useSessionStore.setState({ activeTabId: 'website' }))
    await act(async () => { await Promise.resolve() })

    expect(container.textContent).toContain('ion-website')
    expect((window as unknown as { ion: { gitRefresh: ReturnType<typeof vi.fn> } }).ion.gitRefresh).toHaveBeenCalledWith('/repos/ion-website')
    act(() => root.unmount())
    container.remove()
  })

  it('reveals matching staged section', async () => {
    useSessionStore.setState({ activeTabId: 'website' })
    useSurfaceStore.getState().revealDiffFile({ filePath: 'site/index.ts', staged: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<DiffSurface />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(scrollIntoViewMock).toHaveBeenCalled()
    expect((window as unknown as { ion: { gitDiff: ReturnType<typeof vi.fn> } }).ion.gitDiff).toHaveBeenCalledWith('/repos/ion-website', 'site/index.ts', true)
    act(() => root.unmount())
    container.remove()
  })
})
