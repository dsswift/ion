// @vitest-environment jsdom
/**
 * InboxRowMenu — Rename conversation and worktree.
 *
 * The one place the operator can rename a conversation and its worktree in a
 * single act. This pins that the row is offered only for a worktree
 * conversation and that applying the dialog calls `renameTabAndWorktree`.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '@ion/shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renameTabAndWorktree = vi.fn(async () => undefined)
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
  forkTab: vi.fn(async () => 'new-tab-id'),
  renameTabAndWorktree,
}

vi.mock('@ion/server/store/sessionStore', () => ({
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
  // The dialog portals into the popover layer; give it the document body.
  usePopoverLayer: () => document.body,
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
  window.ion = {
    gitIsRepo: vi.fn().mockResolvedValue({ isRepo: false }),
    gitChanges: vi.fn(),
    // The menu's Transfer gate asks which other Environments are connected.
    hostGetConnections: vi.fn().mockResolvedValue([]),
    onHostConnections: vi.fn(() => () => {}),
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

const WORKTREE = {
  worktreePath: '/repo-wt', branchName: 'wt/a3f1', sourceBranch: 'main', repoPath: '/repo',
} as unknown as TabState['worktree']

function renameBothButton(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Rename conversation and worktree…')
}

describe('InboxRowMenu — Rename conversation and worktree', () => {
  it('omits the row for a conversation with no worktree', async () => {
    await openMenu(tab())
    // The menu is open (plain Rename is there); only the worktree verb is absent.
    expect(Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent === 'Rename')).toBe(true)
    expect(renameBothButton()).toBeUndefined()
  })

  it('opens the dialog and renames both through the store action', async () => {
    await openMenu(tab({ customTitle: 'Named by hand', worktree: WORKTREE }))
    act(() => { renameBothButton()!.click() })

    const apply = document.body.querySelector<HTMLButtonElement>('[data-testid="rename-tab-worktree-apply"]')
    expect(apply).not.toBeNull()
    await act(async () => { apply!.click(); await Promise.resolve() })

    // The dialog starts from the conversation's own name and submits it as-is.
    expect(renameTabAndWorktree).toHaveBeenCalledWith('tab-1', 'Named by hand')
    expect(document.body.querySelector('[data-testid="rename-tab-worktree-apply"]')).toBeNull()
  })
})
