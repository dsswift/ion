// @vitest-environment jsdom
/**
 * InboxRowMenu — Transfer.
 *
 * The Inbox is the primary conversation surface, so every conversation verb
 * has to be reachable from an inbox row's context menu — not only from the
 * tab-strip pill. This pins that the inbox menu wires the same
 * `useTransferGate` visibility/enablement gate and opens the same
 * window-level Transfer dialog the tab-strip menu opens, rather than omitting
 * the verb.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '@ion/shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  convertToWorktree: vi.fn().mockResolvedValue({ ok: true }),
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
vi.mock('./ConversationHoverCard', () => ({
  ConversationHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
// The convert gate probes git over the wire; this suite is about Transfer.
vi.mock('../../components/useConvertToWorktreeGate', () => ({
  useConvertToWorktreeGate: () => ({ show: false, disabled: true, label: 'Convert to worktree' }),
}))

// The gate itself (catalog + connection phases) is pinned by its own tests.
const transferGateMock = { disabled: false }
vi.mock('../transfer/useTransferGate', () => ({
  useTransferGate: () => transferGateMock,
}))
const openTransferDialog = vi.fn()
vi.mock('../transfer/TransferDialogHost', () => ({
  openTransferDialog: (request: unknown) => openTransferDialog(request),
}))

import { InboxRow } from './InboxRow'
import { installFakeWire } from '../../host/__tests__/fake-wire'

function tab(over: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-1',
    conversationId: 'conv-1',
    title: 'My conversation',
    customTitle: null,
    status: 'idle',
    workingDirectory: '/repo',
    worktree: null,
    ...over,
  } as TabState
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.clearAllMocks()
  transferGateMock.disabled = false
  window.ion = installFakeWire({}) as unknown as typeof window.ion
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

function transferButton(): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Transfer'))
}

describe('InboxRowMenu — Transfer', () => {
  it('offers the row when the gate allows it', async () => {
    await openMenu(tab())

    const button = transferButton()
    expect(button).toBeDefined()
    expect(button!.disabled).toBe(false)
  })

  it('opens the same window-level Transfer dialog the tab-strip menu opens, and closes itself', async () => {
    await openMenu(tab())
    act(() => { transferButton()!.click() })

    expect(openTransferDialog).toHaveBeenCalledWith({ tabId: 'tab-1', initialMode: 'conversation' })
    // The row's menu is gone; the dialog must not depend on this row, which
    // the move deletes.
    expect(transferButton()).toBeUndefined()
  })

  it('renders the row disabled and inert when the gate refuses', async () => {
    transferGateMock.disabled = true

    await openMenu(tab())

    const button = transferButton()
    expect(button).toBeDefined()
    expect(button!.disabled).toBe(true)

    act(() => { button!.click() })
    expect(openTransferDialog).not.toHaveBeenCalled()
  })

})
