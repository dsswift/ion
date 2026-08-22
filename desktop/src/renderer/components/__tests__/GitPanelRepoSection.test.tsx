// @vitest-environment jsdom
/**
 * GitPanelRepoSection: per-repo section behavior — collapse defaults
 * (primary expanded, secondary collapsed; persisted map overrides), and the
 * onFileDiffClick override reaching GitChangesSection (payload carries the
 * SECTION's repo dir, which is what makes multi-repo diff reveals land in
 * the right repo).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useSessionStore } from '../../stores/sessionStore'
import { usePreferencesStore } from '../../preferences'
import { useGitStore } from '../../stores/git'
import { GitPanelRepoSection } from '../GitPanelRepoSection'
import { PopoverLayerProvider } from '../PopoverLayer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  ;(window as unknown as { ion: unknown }).ion = {
    gitSubscribe: vi.fn().mockResolvedValue({ snapshot: null }),
    gitUnsubscribe: vi.fn().mockResolvedValue(undefined),
    gitRefresh: vi.fn().mockResolvedValue(undefined),
    gitDiff: vi.fn().mockResolvedValue({ diff: '', fileName: '' }),
    onGitEvent: vi.fn(() => () => undefined),
    // CommitForm reads .commit.json prefixes; persistence flushes tabs.
    fsReadFile: vi.fn().mockResolvedValue({ content: null }),
    saveTabs: vi.fn().mockResolvedValue(undefined),
    saveTabContent: vi.fn().mockResolvedValue(undefined),
  }
  useSessionStore.setState({ activeTabId: 'tab-1' })
  usePreferencesStore.setState({ gitPanelRepoSectionsCollapsed: {}, gitChangesTreeView: false })
  useGitStore.setState({
    repos: {
      '/repo/secondary': {
        repoPath: '/repo/secondary',
        branch: 'main',
        files: [{ path: 'src/x.ts', staged: false, status: 'modified' }],
        revision: 1,
      } as never,
    },
  })
})

function render(el: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<PopoverLayerProvider>{el}</PopoverLayerProvider>)
  })
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

describe('GitPanelRepoSection', () => {
  it('secondary sections default collapsed; persisted map overrides', () => {
    const a = render(<GitPanelRepoSection directory="/repo/secondary" isPrimary={false} />)
    // Collapsed: no CommitForm textarea rendered.
    expect(a.container.querySelector('textarea')).toBeNull()
    a.unmount()

    usePreferencesStore.setState({ gitPanelRepoSectionsCollapsed: { '/repo/secondary': false } })
    const b = render(<GitPanelRepoSection directory="/repo/secondary" isPrimary={false} />)
    expect(b.container.querySelector('textarea')).not.toBeNull()
    b.unmount()
  })

  it('primary sections default expanded', () => {
    useGitStore.setState({
      repos: { '/repo/main': { repoPath: '/repo/main', branch: 'main', files: [], revision: 1 } as never },
    })
    const { container, unmount } = render(<GitPanelRepoSection directory="/repo/main" isPrimary />)
    expect(container.querySelector('textarea')).not.toBeNull()
    unmount()
  })

  it('file-row click falls back to local popup when Studio declines workspace repo', async () => {
    usePreferencesStore.setState({ gitPanelRepoSectionsCollapsed: { '/repo/secondary': false } })
    const onFileDiffClick = vi.fn().mockReturnValue(false)
    const { container, unmount } = render(
      <GitPanelRepoSection directory="/repo/secondary" isPrimary={false} onFileDiffClick={onFileDiffClick} />,
    )
    // Find the changed-file row: the innermost element whose text contains
    // the filename (row layout may split path/name across spans).
    const candidates = [...container.querySelectorAll('*')].filter(
      (el) => (el.textContent ?? '').includes('x.ts') && el.children.length === 0,
    )
    expect(candidates.length).toBeGreaterThan(0)
    act(() => {
      ;(candidates[0] as HTMLElement).click()
    })
    expect(onFileDiffClick).toHaveBeenCalledWith({ repoDir: '/repo/secondary', filePath: 'src/x.ts', staged: false })
    await act(async () => { await Promise.resolve() })
    expect((window as unknown as { ion: { gitDiff: ReturnType<typeof vi.fn> } }).ion.gitDiff).toHaveBeenCalledWith('/repo/secondary', 'src/x.ts', false)
    unmount()
  })
})
