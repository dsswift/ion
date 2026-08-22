// @vitest-environment jsdom
/**
 * Regression: clicking any verb in the inbox row's context menu ALSO selected
 * the row, switching the operator to that conversation.
 *
 * `InboxRowMenu` is rendered as a child of the row element in the React tree
 * and portals into `PopoverLayer`. A React portal moves the DOM node but NOT
 * the React event path: a synthetic click inside the portal still bubbles
 * through the React ancestors of where the element was DECLARED, so every menu
 * click reached the row's own `onClick` and ran `selectTab`.
 *
 * The reported symptom was "I right-clicked the other conversation, clicked
 * regenerate title, and nothing happened except it switched to the other
 * conversation" — the switch was this bubbling, and it made a silent verb look
 * like it had done something unrelated.
 *
 * Regression direction: removing the menu container's `stopPropagation` lets
 * `selectTab` fire again and turns every test here red.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = {
  activeTabId: 'other-tab' as string | null,
  conversationPanes: new Map(),
  benchWorkspaces: new Map(),
  selectTab: vi.fn(),
  renameTab: vi.fn(),
  unsnoozeTab: vi.fn(),
  snoozeTab: vi.fn(),
  markTabUnread: vi.fn(),
  pinTab: vi.fn(),
  unpinTab: vi.fn(),
  settleTab: vi.fn(async () => undefined),
  unsettleTab: vi.fn(async () => undefined),
  regenerateTabTitle: vi.fn(async () => undefined),
  deleteConversationTab: vi.fn(async () => undefined),
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))
vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (s: { inboxAutoSettleDays: number }) => unknown) => selector({ inboxAutoSettleDays: 0 }),
}))
vi.mock('../../components/PopoverLayer', () => ({
  usePopoverLayer: () => null,
}))
vi.mock('./ConversationHoverCard', () => ({
  ConversationHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { InboxRow } from './InboxRow'

function tab(): TabState {
  return {
    id: 'tab-1',
    conversationId: 'conv-1',
    title: 'My conversation',
    customTitle: null,
    status: 'idle',
    workingDirectory: '/repo',
  } as TabState
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.clearAllMocks()
  state.activeTabId = 'other-tab'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // The row menu now includes the same convert-to-worktree gate the tab-strip
  // menu uses, which probes window.ion.gitIsRepo on mount. Stub it closed (not
  // a repo) so it stays inert for this bubbling-regression test.
  window.ion = {
    gitIsRepo: vi.fn().mockResolvedValue({ isRepo: false }),
    gitChanges: vi.fn().mockResolvedValue({ files: [] }),
  } as unknown as typeof window.ion
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Open the row's context menu and click the verb with this label. */
function clickVerb(label: string): void {
  const t = tab()
  act(() => root.render(
    <InboxRow tab={t} unread={false} woke={false} projectName={null} variant="card" backgroundLiveness={null} />,
  ))
  const row = host.querySelector<HTMLDivElement>(`[data-inbox-tab-id="${t.id}"]`)!
  act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
  const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label)
  expect(button, `menu verb ${label} must exist`).toBeDefined()
  act(() => { button!.click() })
}

describe('InboxRowMenu does not select the row it acts on', () => {
  it('runs Regenerate title without switching conversations', () => {
    clickVerb('Regenerate title')
    expect(state.regenerateTabTitle).toHaveBeenCalledWith('tab-1')
    // The operator stays where they were. This is the reported symptom.
    expect(state.selectTab).not.toHaveBeenCalled()
  })

  it('runs Mark unread without switching conversations', () => {
    clickVerb('Mark unread')
    expect(state.markTabUnread).toHaveBeenCalledWith('tab-1')
    expect(state.selectTab).not.toHaveBeenCalled()
  })

  it('runs Settle without switching conversations', () => {
    clickVerb('Settle')
    expect(state.settleTab).toHaveBeenCalledWith('tab-1')
    expect(state.selectTab).not.toHaveBeenCalled()
  })

  it('runs Pin conversation without switching conversations', () => {
    clickVerb('Pin conversation')
    expect(state.pinTab).toHaveBeenCalledWith('tab-1')
    expect(state.selectTab).not.toHaveBeenCalled()
  })

  it('opens the inline rename input without switching conversations', () => {
    clickVerb('Rename')
    expect(host.querySelector('input')).not.toBeNull()
    expect(state.selectTab).not.toHaveBeenCalled()
  })

  it('still selects the row on a normal left click', () => {
    // The guard must be scoped to the menu. A plain row click is how the
    // operator opens a conversation and must keep working.
    const t = tab()
    act(() => root.render(
      <InboxRow tab={t} unread={false} woke={false} projectName={null} variant="card" backgroundLiveness={null} />,
    ))
    const row = host.querySelector<HTMLDivElement>(`[data-inbox-tab-id="${t.id}"]`)!
    act(() => { row.click() })
    expect(state.selectTab).toHaveBeenCalledWith('tab-1')
  })
})
