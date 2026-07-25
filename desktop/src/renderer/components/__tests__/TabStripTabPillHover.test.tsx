// @vitest-environment jsdom
//
// Interactive-state pin for the tab pill (desktop style guide § "Interactive
// states"). The historical gap: inactive tab pills had NO hover state at all —
// the background stayed 'transparent' under the pointer. The fix drives the
// pill background through useInteractiveState():
//
//   - inactive pill + hover  → colors.tabHover
//   - pointer leaves         → back to 'transparent'
//   - active pill            → keeps the dedicated colors.tabActive treatment
//                              (hover must NOT override it)
//   - user pillColor         → the runtime `${pillColor}NN` alpha-concat
//                              deepens 10 → 18 on hover
//
// Reverting the hover wiring in TabStripTabPill.tsx turns these red.
// Mock/render scaffolding follows TabStripGroupPillBadgeSwitch.test.tsx
// (createRoot + act, stubbed stores and useColors).
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ─── Module stubs ─────────────────────────────────────────────────────────────

vi.mock('@phosphor-icons/react', () => ({
  // TabPill's own icons:
  X: () => null, GitBranch: () => null, GitFork: () => null,
  FolderSimple: () => null, PushPin: () => null, Warning: () => null,
  // PILL_ICON_MAP icons pulled in transitively via the real TabStripShared:
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))

// Distinct, jsdom-parseable values for the tokens under test; every other
// token resolves to a neutral fallback via the Proxy.
const TOKEN_OVERRIDES: Record<string, string> = {
  tabHover: 'rgb(1, 2, 3)',
  tabActive: 'rgb(4, 5, 6)',
  surfacePressed: 'rgb(7, 8, 9)',
}

vi.mock('../../theme', () => ({
  useColors: () =>
    new Proxy(TOKEN_OVERRIDES, {
      get: (t, prop) => (t as Record<string, string>)[String(prop)] ?? '#000000',
    }),
}))

vi.mock('../../preferences', () => {
  const state = {
    gitOpsMode: 'plain',
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

const mockStore = {
  conversationPanes: new Map(),
  engineModelFallbacks: new Map(),
}

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

function makeTab(overrides: Partial<TabState> = {}): TabState {
  return {
    id: 't1',
    title: 'Conversation',
    customTitle: null,
    engineProfileId: null,
    workingDirectory: '/work/ion',
    status: 'idle',
    worktree: false,
    pillColor: null,
    ...overrides,
  } as unknown as TabState
}

const noop = () => {}

function renderPill(tab: TabState, isActive: boolean): { pill: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => {
    root.render(
      <TabPill
        tab={tab}
        isActive={isActive}
        isEditing={false}
        isConfirmingClose={false}
        onSelect={noop}
        onClose={noop}
        onStartEdit={noop}
        onStopEdit={noop}
        onRename={noop}
        onConfirmClose={noop}
        onCancelClose={noop}
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
  const pill = container.querySelector('.group') as HTMLElement
  expect(pill).not.toBeNull()
  return { pill, unmount: () => act(() => root.unmount()) }
}

// React derives onMouseEnter/onMouseLeave from bubbling mouseover/mouseout.
function hover(el: HTMLElement) {
  act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
}
function unhover(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
  })
}

describe('TabPill hover state (inactive pill)', () => {
  it('applies colors.tabHover on mouseenter and clears it on mouseleave', () => {
    const { pill, unmount } = renderPill(makeTab(), false)
    try {
      expect(pill.style.background).toBe('transparent')

      hover(pill)
      expect(pill.style.background).toBe('rgb(1, 2, 3)') // colors.tabHover

      unhover(pill)
      expect(pill.style.background).toBe('transparent')
    } finally {
      unmount()
    }
  })

  it('keeps the dedicated tabActive treatment on the active pill (hover does not override)', () => {
    const { pill, unmount } = renderPill(makeTab(), true)
    try {
      expect(pill.style.background).toBe('rgb(4, 5, 6)') // colors.tabActive

      hover(pill)
      expect(pill.style.background).toBe('rgb(4, 5, 6)') // unchanged
    } finally {
      unmount()
    }
  })

  it('deepens a user pillColor from 10 to 18 alpha on hover (runtime concat pattern)', () => {
    const { pill, unmount } = renderPill(makeTab({ pillColor: '#ff0000' } as Partial<TabState>), false)
    try {
      // jsdom normalizes the 8-digit hex concat to rgba():
      //   #ff000010 → alpha 16/255 ≈ 0.063, #ff000018 → alpha 24/255 ≈ 0.094
      expect(pill.style.background).toBe('rgba(255, 0, 0, 0.063)')

      hover(pill)
      expect(pill.style.background).toBe('rgba(255, 0, 0, 0.094)')

      unhover(pill)
      expect(pill.style.background).toBe('rgba(255, 0, 0, 0.063)')
    } finally {
      unmount()
    }
  })
})
