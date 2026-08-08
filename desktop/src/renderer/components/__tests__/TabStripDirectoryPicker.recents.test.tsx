// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const portal = document.createElement('div')
document.body.appendChild(portal)
const localDirectory = '/Volumes/projects/alpha'
const worktreeDirectory = '/Users/example/.ion/worktrees/project-a3f1'
const benchDirectory = '/Users/example/.ion/integration/project-main'

const sessionState = {
  tabs: [{ workingDirectory: '/Volumes/projects/alpha' }],
  worktreeInventory: new Map([['/Volumes/projects/alpha', [{
    worktreePath: worktreeDirectory,
    branchName: 'wt/project-a3f1',
    label: 'project-a3f1',
    title: 'Feature work',
    isDirty: false,
    needsSync: false,
  }]]]),
  benchWorkspaces: new Map([['/Volumes/projects/alpha', [{
    benchPath: benchDirectory,
    sourceBranch: 'main',
    lastBuiltAt: 1,
    members: [{ enabled: true }],
  }]]]),
  staticInfo: { homePath: '/Users/example' },
  refreshWorktreeInventory: vi.fn(async () => {}),
  refreshBench: vi.fn(async () => {}),
  openBenchTerminal: vi.fn(async () => {}),
  openWorktreeConversation: vi.fn(async () => {}),
}

vi.mock('../../stores/sessionStore', () => {
  const useSessionStore = (selector: (state: typeof sessionState) => unknown) => selector(sessionState)
  useSessionStore.getState = () => sessionState
  return { useSessionStore }
})

const preferencesState = {
  recentBaseDirectories: [localDirectory, worktreeDirectory, benchDirectory],
  directoryUsageCounts: { [localDirectory]: 2, [worktreeDirectory]: 99 },
  uiZoom: 1,
  removeRecentBaseDirectory: vi.fn(),
}
vi.mock('../../preferences', () => {
  const usePreferencesStore = (selector: (state: typeof preferencesState) => unknown) => selector(preferencesState)
  usePreferencesStore.getState = () => preferencesState
  return { usePreferencesStore }
})

vi.mock('../PopoverLayer', () => ({ usePopoverLayer: () => portal }))
vi.mock('../../hooks/useViewportClamp', () => ({ useViewportClamp: () => {} }))
vi.mock('../../stores/remote-fs-store', () => ({ pickDirectoryForSession: vi.fn() }))
vi.mock('../../rendererLogger', () => ({ rError: vi.fn() }))
vi.mock('../../theme', () => ({
  useColors: () => ({
    popoverBg: '#000', popoverBorder: '#111', textPrimary: '#fff', textSecondary: '#aaa',
    textTertiary: '#777', tabActive: '#222', accent: '#0bf', worktreeGreen: '#0f0', warningFg: '#fa0',
  }),
}))

import { DirectoryPicker } from '../TabStripDirectoryPicker'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('DirectoryPicker recent directories', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    if (container) {
      act(() => root.unmount())
      container.remove()
    }
    portal.replaceChildren()
  })

  it('keeps named worktree and bench rows while excluding their raw paths from local recents', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <DirectoryPicker
          anchor={{ x: 0, y: 0, bottom: 0 }}
          onSelectDir={vi.fn()}
          onClose={vi.fn()}
        />,
      )
    })

    expect(portal.textContent).toContain('Feature work')
    expect(portal.textContent).toContain('Bench · main')
    expect(portal.textContent).toContain(localDirectory)
    expect(portal.querySelector(`[title="${worktreeDirectory}"]`)).toBeTruthy()
    expect(portal.querySelector(`[title="${benchDirectory}"]`)).toBeTruthy()
    expect(portal.querySelectorAll(`[title="${worktreeDirectory}"]`)).toHaveLength(1)
    expect(portal.querySelectorAll(`[title="${benchDirectory}"]`)).toHaveLength(1)
  })
})
