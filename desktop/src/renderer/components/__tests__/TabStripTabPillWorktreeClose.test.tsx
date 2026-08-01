// @vitest-environment jsdom
/**
 * A worktree conversation must be closeable from the tab strip.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * `TabStripTabPill` rendered `{tab.worktree ? null : ...}` around its close
 * affordance, and the middle-click handler skipped `tab.worktree`. Both dated to
 * when `closeTab` ran `gitWorktreeRemove(force=true)` + `git branch -D`, where
 * hiding the X was a genuine safety measure.
 *
 * The worktree lifecycle split made close non-destructive — a worktree outlives
 * its conversations, and removal is the explicit Retire verb — but the
 * suppressions stayed. The result: a worktree tab had NO close affordance in the
 * strip at all. The operator's only route was Cmd+W, which is not discoverable
 * and reads as "this tab cannot be closed".
 *
 * These tests fail against that implementation: the X assertion finds no button,
 * and the middle-click assertion sees no onClose call.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@phosphor-icons/react', () => ({
  X: () => null, GitBranch: () => null, GitFork: () => null,
  FolderSimple: () => null, PushPin: () => null, Warning: () => null,
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../../preferences', () => {
  const state = {
    gitOpsMode: 'worktree',
    tabGroupMode: 'off',
    engineProfiles: [] as Array<{ id: string; name: string }>,
    uiZoom: 1,
  }
  const usePreferencesStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { usePreferencesStore }
})

const mockStore = { conversationPanes: new Map(), engineModelFallbacks: new Map() }
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mockStore),
    { getState: () => mockStore },
  ),
}))

vi.mock('../TabStripStatusDot', () => ({ StatusDot: () => null }))
vi.mock('../TabStripInlineRenameInput', () => ({ InlineRenameInput: () => null }))

import { TabPill } from '../TabStripTabPill'
import type { TabState } from '../../../shared/types'

const noop = () => {}

/** A worktree conversation: the tab shape that had no close affordance. */
function makeWorktreeTab(overrides: Partial<TabState> = {}): TabState {
  return {
    id: 't-wt',
    title: 'Worktree work',
    customTitle: null,
    engineProfileId: null,
    workingDirectory: '/Users/test/.ion/worktrees/ion-a3f1',
    status: 'idle',
    worktree: {
      worktreePath: '/Users/test/.ion/worktrees/ion-a3f1',
      branchName: 'wt/ion-a3f1',
      sourceBranch: 'main',
      repoPath: '/Users/test/src/ion',
    },
    pillColor: null,
    ...overrides,
  } as unknown as TabState
}

function renderPill(tab: TabState, onClose: () => void) {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => {
    root.render(
      <TabPill
        tab={tab}
        isActive
        isEditing={false}
        onSelect={noop}
        onClose={onClose}
        onStartEdit={noop}
        onStopEdit={noop}
        onRename={noop}
        onSetPillColor={noop}
        colorPickerTabId={null}
        onOpenColorPicker={noop}
        onCloseColorPicker={noop}
        onOpenDirMenu={noop}
        onCreateTabInDir={noop}
        dirMenuTabId={null}
        onOpenTabMenu={noop}
        tabRefs={{ current: new Map() }}
        onDragPointerDown={noop}
        isDraggingRef={{ current: false }}
      />,
    )
  })
  return { container, unmount: () => act(() => root.unmount()) }
}

describe('worktree tab close affordance', () => {
  it('renders a close button for a worktree conversation', () => {
    const onClose = vi.fn()
    const { container, unmount } = renderPill(makeWorktreeTab(), onClose)

    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.length, 'a worktree tab must have a close button').toBeGreaterThan(0)

    act(() => { buttons[buttons.length - 1].click() })
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('closes a worktree conversation on middle-click', () => {
    const onClose = vi.fn()
    const { container, unmount } = renderPill(makeWorktreeTab(), onClose)

    const pill = container.querySelector('.group') as HTMLElement
    act(() => {
      pill.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 1 }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
  })

  // The running-work guard is orthogonal to the worktree question and must still
  // hold: removing the worktree suppression must not have widened the guard.
  it('still suppresses close while the orchestrator is running', () => {
    const onClose = vi.fn()
    const { container, unmount } = renderPill(
      makeWorktreeTab({ status: 'running' } as Partial<TabState>),
      onClose,
    )

    const pill = container.querySelector('.group') as HTMLElement
    act(() => {
      pill.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 1 }))
    })

    expect(onClose, 'a running tab must not close on middle-click').not.toHaveBeenCalled()
    unmount()
  })
})
