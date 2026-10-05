// @vitest-environment jsdom
/**
 * InboxRowMenu — Copy link.
 *
 * The row menu copies the conversation's `ion://conversation` link, built by
 * the shared builder the server's parser round-trips. A terminal-only tab has
 * no conversation to link to, so the verb is absent there.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '@ion/shared/types'

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
  usePopoverLayer: () => null,
}))
const copyDeepLink = vi.fn().mockResolvedValue(undefined)
vi.mock('../../deeplink-client', () => ({ copyDeepLink: (url: string) => copyDeepLink(url) }))
vi.mock('./ConversationHoverCard', () => ({
  ConversationHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { InboxRow } from './InboxRow'
import { conversationLink } from '@ion/shared/deeplink-url'

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
  copyDeepLink.mockResolvedValue(undefined)
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

function copyLinkButton(): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Copy link')
}

describe('InboxRowMenu — Copy link', () => {
  it('copies the conversation link from the shared builder', async () => {
    await openMenu(tab())
    act(() => { copyLinkButton()!.click() })
    expect(copyDeepLink).toHaveBeenCalledWith(conversationLink('conv-1'))
  })

  it('omits the verb for a terminal-only tab', async () => {
    await openMenu(tab({ isTerminalOnly: true } as Partial<TabState>))
    expect(copyLinkButton()).toBeUndefined()
  })

  it('omits the verb when the tab has no conversation yet', async () => {
    await openMenu(tab({ conversationId: null }))
    expect(copyLinkButton()).toBeUndefined()
  })
})
