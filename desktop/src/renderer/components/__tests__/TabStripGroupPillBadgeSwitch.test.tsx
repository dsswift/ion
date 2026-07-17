// @vitest-environment jsdom
//
// Regression test for the stale extension-badge bug on the active tab-group
// pill. The original GroupPill computed `harnessBadgeLabel` inside a
// usePreferencesStore selector closure:
//
//   const harnessBadgeLabel = usePreferencesStore((s) => {
//     if (!selectedTab?.engineProfileId) return null
//     ...
//   })
//
// `selectedTab` comes from props (group.selectedTabId), NOT from the
// preferences store. When the user switched the selected tab within the group
// — extension tab -> plain tab — while `engineProfiles` was unchanged, the
// store-subscribed selector did not re-evaluate against the new selectedTab, so
// the previous tab's extension badge stayed painted on the now-selected plain
// tab (the reported defect: a badge with no extension running in that tab).
//
// The fix derives the label synchronously from `selectedTab` in the render body
// (subscribing only to the stable engineProfiles array). This test re-renders
// the SAME GroupPill fiber across the switch and asserts the badge clears.
// Reverting the fix (moving the derivation back into the selector closure) turns
// this red — the definition of a regression test.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ─── Module stubs ─────────────────────────────────────────────────────────────
// GroupPill pulls in framer-motion, phosphor, the theme, both stores, and a
// handful of child components. Stub everything that isn't the unit under test so
// the badge-derivation path renders in isolation.

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
}))

vi.mock('@phosphor-icons/react', () => ({
  // GroupPill's own icons:
  X: () => null, CaretDown: () => null, PencilSimple: () => null, PushPin: () => null,
  // PILL_ICON_MAP icons pulled in transitively via the real TabStripShared:
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))

vi.mock('../../theme', () => ({
  // Proxy yields a color string for any key the component reads.
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

// Stable engineProfiles array reference shared across renders — this is the
// crux of the regression. On the old code the selector that depended on this
// store would not re-run when only the `group` prop changed, so the badge went
// stale. The reference must NOT change between the two renders. Declared via
// vi.hoisted so it is available inside the hoisted vi.mock factory below.
const { ENGINE_PROFILES } = vi.hoisted(() => ({
  ENGINE_PROFILES: [
    { id: 'cos', name: 'COS' },
    { id: 'ion-dev', name: 'ion-dev' },
  ],
}))

// Mock usePreferencesStore with a REAL Zustand store. This is the crux of the
// regression: the bug only reproduces with Zustand's genuine snapshot-caching
// behavior, where a selector closure that captured a prop returns a stale value
// on a prop-only re-render (store state unchanged). A hand-rolled mock that
// re-invokes the selector every render would mask the bug entirely. By backing
// the mock with `create()` we exercise the same useSyncExternalStore path the
// production store uses, so the pre-fix closure form goes stale exactly as it
// did in the app, and the post-fix render-body derivation stays correct.
vi.mock('../../preferences', async () => {
  const { create } = await import('zustand')
  const usePreferencesStore = create(() => ({
    tabGroupMode: 'auto' as const,
    engineProfiles: ENGINE_PROFILES,
  }))
  return { usePreferencesStore }
})

const mockStore = {
  renameTab: () => {},
  setTabPillColor: () => {},
  setTabPillIcon: () => {},
  worktreeUncommittedMap: new Map(),
  conversationPanes: new Map(),
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mockStore),
    { getState: () => mockStore },
  ),
}))

vi.mock('../TabStripStatusDot', () => ({ GroupStatusDot: () => null }))
vi.mock('../TabStripInlineRenameInput', () => ({ InlineRenameInput: () => null }))
vi.mock('../TabStripPillColorPicker', () => ({ PillColorPicker: () => null }))
vi.mock('../TabStripTabContextMenu', () => ({ TabContextMenu: () => null }))
vi.mock('../TabStripInactiveGroupMenu', () => ({ InactiveGroupMenu: () => null }))
vi.mock('../TabStripGroupPickerDropdown', () => ({ GroupPickerDropdown: () => null }))
vi.mock('../new-conversation-routing', () => ({ newTabInDirectory: () => {} }))

// getWaitingState / checkWorktreeUncommitted etc. read the (mocked) stores; the
// real implementations are pure enough to run under the stubs above, so we keep
// TabStripShared real to exercise the actual abbreviateProfileName path.

import { GroupPill } from '../TabStripGroupPill'
import type { TabState } from '../../../shared/types'
import type { TabGroupView } from '../../hooks/useTabGroups'

function makeTab(id: string, engineProfileId: string | null, title: string): TabState {
  return {
    id,
    title,
    customTitle: null,
    engineProfileId,
    workingDirectory: '/work/ion',
    status: 'idle',
    worktree: false,
  } as unknown as TabState
}

// Two tabs in one group: an extension tab (badge) and a plain tab (no badge).
const EXT_TAB = makeTab('ext', 'cos', 'CIA Implementation')
const PLAIN_TAB = makeTab('plain', null, 'Agent dispatch window')

function makeGroup(selectedTabId: string): TabGroupView {
  return {
    groupId: 'g1',
    label: 'Planning',
    tabs: [EXT_TAB, PLAIN_TAB],
    isDefault: false,
    collapsed: true,
    selectedTabId,
    order: 0,
  }
}

/** Mount GroupPill with the first selected tab, then re-render the SAME root
 *  with the second selected tab. Returns final HTML for assertions. */
function renderThenSwitch(firstSelectedId: string, secondSelectedId: string): { first: string; second: string } {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => {
      root.render(<GroupPill group={makeGroup(firstSelectedId)} isActive onSelect={() => {}} />)
    })
    const first = container.innerHTML
    act(() => {
      root.render(<GroupPill group={makeGroup(secondSelectedId)} isActive onSelect={() => {}} />)
    })
    const second = container.innerHTML
    return { first, second }
  } finally {
    act(() => { root.unmount() })
  }
}

describe('GroupPill active badge tracks the selected tab', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows the extension badge when an extension tab is selected', () => {
    const { first } = renderThenSwitch('ext', 'ext')
    expect(first).toContain('COS')
  })

  it('clears the badge when switching from an extension tab to a plain tab (regression)', () => {
    const { first, second } = renderThenSwitch('ext', 'plain')
    // First render: extension tab selected → badge present.
    expect(first).toContain('COS')
    // After switching to the plain tab on the SAME fiber the badge must be gone.
    // Pre-fix the stale selector kept 'COS' painted here.
    expect(second).not.toContain('COS')
    // The plain tab's own title is what should be visible.
    expect(second).toContain('Agent dispatch window')
  })

  it('shows no badge at all when the plain tab is selected from the start', () => {
    const { first } = renderThenSwitch('plain', 'plain')
    expect(first).not.toContain('COS')
    expect(first).toContain('Agent dispatch window')
  })
})
