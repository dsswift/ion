// @vitest-environment jsdom
/**
 * FileExplorer multi-root render: section ordering (primary first, then
 * workspace roots sorted), dedupe (active dir never doubles), collapsed
 * header-only render, and remove affordance only on secondary roots.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useSessionStore } from '../../stores/sessionStore'
import { usePreferencesStore } from '../../preferences'
import { FileExplorer } from '../FileExplorer'
import { PopoverLayerProvider } from '../PopoverLayer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  ;(window as unknown as { ion: unknown }).ion = {
    fsReadDir: vi.fn().mockResolvedValue({ entries: [] }),
    gitIgnoredFiles: vi.fn().mockResolvedValue({ paths: [] }),
    selectDirectory: vi.fn().mockResolvedValue(null),
    fsRevealInFinder: vi.fn().mockResolvedValue(undefined),
  }
  useSessionStore.setState({
    activeTabId: 'tab-1',
    tabs: [{ id: 'tab-1', workingDirectory: '/proj/main' }] as never,
    fileExplorerRootCollapsed: new Set<string>(),
    fileExplorerStates: new Map(),
  })
  usePreferencesStore.setState({
    workspaceFolders: { '/proj/main': ['/lib/zeta', '/lib/alpha', '/proj/main'] },
  })
})

function render(): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <PopoverLayerProvider>
        <FileExplorer />
      </PopoverLayerProvider>,
    )
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

describe('FileExplorer multi-root', () => {
  it('renders primary first, workspace roots sorted, active dir deduped', () => {
    const { container, unmount } = render()
    const text = container.textContent ?? ''
    // Primary header + two sorted secondary roots; '/proj/main' in the
    // workspace list dedupes against the primary.
    const mainIdx = text.indexOf('MAIN')
    const alphaIdx = text.indexOf('ALPHA')
    const zetaIdx = text.indexOf('ZETA')
    expect(mainIdx).toBeGreaterThanOrEqual(0)
    expect(alphaIdx).toBeGreaterThan(mainIdx)
    expect(zetaIdx).toBeGreaterThan(alphaIdx)
    expect(text.match(/MAIN/g)).toHaveLength(1)
    // Multi-root workspaces get the WORKSPACE panel title.
    expect(text).toContain('WORKSPACE')
    unmount()
  })

  it('remove affordance exists only on secondary roots', () => {
    const { container, unmount } = render()
    expect(container.querySelector('[aria-label="Root menu for alpha"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Root menu for main"]')).toBeNull()
    unmount()
  })

  it('collapsed root renders header only (no tree fetch loop)', () => {
    useSessionStore.setState({ fileExplorerRootCollapsed: new Set(['/lib/alpha', '/lib/zeta']) })
    const fsReadDir = (window as unknown as { ion: { fsReadDir: ReturnType<typeof vi.fn> } }).ion.fsReadDir
    const { unmount } = render()
    // Only the primary root fetches; both collapsed roots skip.
    const fetchedDirs = fsReadDir.mock.calls.map((c: unknown[]) => c[0])
    expect(fetchedDirs).toContain('/proj/main')
    expect(fetchedDirs).not.toContain('/lib/alpha')
    expect(fetchedDirs).not.toContain('/lib/zeta')
    unmount()
  })

  it('no-directory tab renders nothing', () => {
    useSessionStore.setState({ tabs: [{ id: 'tab-1', workingDirectory: '~' }] as never })
    const { container, unmount } = render()
    expect(container.textContent).toBe('')
    unmount()
  })

  it('single-root project keeps the project-name panel title', () => {
    usePreferencesStore.setState({ workspaceFolders: {} })
    const { container, unmount } = render()
    expect(container.textContent).toContain('MAIN')
    expect(container.textContent).not.toContain('WORKSPACE')
    unmount()
  })
})
