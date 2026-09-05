// @vitest-environment jsdom
/**
 * InboxRowMenu — Fork conversation.
 *
 * The inbox row's context menu is a second entry point to the same
 * `forkTab` store action the tab-strip context menu (`TabStripTabContextMenu.tsx`)
 * exposes. This pins that the row appears only for a minted conversation, is
 * absent once the tab's worktree has landed (a sealed read-only record that
 * accepts no new forks), and calls the same store action.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const forkTab = vi.fn().mockResolvedValue('new-tab-id')
const state = {
  activeTabId: null as string | null,
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
  convertToWorktree: vi.fn(async () => ({ ok: true })),
  forkTab,
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

function tab(over: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-1',
    conversationId: 'conv-1',
    title: 'My conversation',
    customTitle: null,
    status: 'idle',
    workingDirectory: '/repo',
    worktree: null,
    historicalSessionIds: [],
    ...over,
  } as TabState
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.clearAllMocks()
  forkTab.mockResolvedValue('new-tab-id')
  window.ion = {
    gitIsRepo: vi.fn().mockResolvedValue({ isRepo: false }),
    gitChanges: vi.fn(),
  } as unknown as typeof window.ion
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function openMenu(t: TabState): Promise<void> {
  act(() => root.render(
    <InboxRow tab={t} unread={false} woke={false} projectName={null} variant="card" backgroundLiveness={null} />,
  ))
  const row = host.querySelector<HTMLDivElement>(`[data-inbox-tab-id="${t.id}"]`)!
  act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
  await act(async () => { await Promise.resolve() })
}

function forkButton(): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Fork conversation')
}

describe('InboxRowMenu — Fork conversation', () => {
  it('shows the row for a minted conversation', async () => {
    await openMenu(tab())
    expect(forkButton()).toBeDefined()
  })

  it('calls the same forkTab store action the tab-strip menu uses', async () => {
    await openMenu(tab())
    act(() => { forkButton()!.click() })

    expect(forkTab).toHaveBeenCalledWith('tab-1')
    // Clicking the verb closes the menu, same as every other row action.
    expect(host.querySelector('button')).toBeNull()
  })

  it('omits the row when the tab has no minted conversation', async () => {
    await openMenu(tab({ conversationId: null }))
    expect(forkButton()).toBeUndefined()
  })

  it('omits the row once the worktree has landed', async () => {
    await openMenu(tab({
      worktree: {
        worktreePath: '/repo-wt', branchName: 'wt/a3f1', sourceBranch: 'main', repoPath: '/repo', landedAt: Date.now(),
      } as unknown as TabState['worktree'],
    }))
    expect(forkButton()).toBeUndefined()
  })
})
