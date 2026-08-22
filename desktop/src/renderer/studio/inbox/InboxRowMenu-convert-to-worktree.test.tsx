// @vitest-environment jsdom
/**
 * InboxRowMenu — Convert to worktree.
 *
 * The inbox row's context menu is a second entry point to the exact same
 * `convertToWorktree` store action and `useConvertToWorktreeGate` visibility
 * gate the tab-strip context menu (`TabStripTabContextMenu.tsx`) already
 * exercises. This pins that the inbox menu wires the identical mechanism
 * rather than reimplementing or omitting it: the row is present only for a
 * plain conversation over a clean git repo, disabled while dirty, and absent
 * entirely once the tab already has a worktree.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const convertToWorktree = vi.fn().mockResolvedValue({ ok: true })
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
  convertToWorktree,
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
    ...over,
  } as TabState
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.clearAllMocks()
  convertToWorktree.mockResolvedValue({ ok: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Open the row's context menu and let the convert gate's async probe settle. */
async function openMenu(t: TabState): Promise<void> {
  act(() => root.render(
    <InboxRow tab={t} unread={false} woke={false} projectName={null} variant="card" backgroundLiveness={null} />,
  ))
  const row = host.querySelector<HTMLDivElement>(`[data-inbox-tab-id="${t.id}"]`)!
  act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
  await act(async () => { await Promise.resolve() })
}

function convertButton(): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Convert to worktree'))
}

describe('InboxRowMenu — Convert to worktree', () => {
  it('shows an enabled row for a plain conversation over a clean git repo', async () => {
    window.ion = {
      gitIsRepo: vi.fn().mockResolvedValue({ isRepo: true }),
      gitChanges: vi.fn().mockResolvedValue({ files: [] }),
    } as unknown as typeof window.ion

    await openMenu(tab())

    const button = convertButton()
    expect(button).toBeDefined()
    expect(button!.textContent).toBe('Convert to worktree')
    expect(button!.disabled).toBe(false)
  })

  it('calls the same convertToWorktree store action the tab-strip menu uses', async () => {
    window.ion = {
      gitIsRepo: vi.fn().mockResolvedValue({ isRepo: true }),
      gitChanges: vi.fn().mockResolvedValue({ files: [] }),
    } as unknown as typeof window.ion

    await openMenu(tab())
    act(() => { convertButton()!.click() })

    expect(convertToWorktree).toHaveBeenCalledWith('tab-1')
    // Clicking the verb closes the menu, same as every other row action.
    expect(host.querySelector('button')).toBeNull()
  })

  it('disables the row and names the reason when the checkout is dirty', async () => {
    window.ion = {
      gitIsRepo: vi.fn().mockResolvedValue({ isRepo: true }),
      gitChanges: vi.fn().mockResolvedValue({ files: [{ path: 'a.ts', status: 'M' }] }),
    } as unknown as typeof window.ion

    await openMenu(tab())

    const button = convertButton()
    expect(button).toBeDefined()
    expect(button!.textContent).toBe('Convert to worktree (uncommitted changes)')
    expect(button!.disabled).toBe(true)

    act(() => { button!.click() })
    expect(convertToWorktree).not.toHaveBeenCalled()
  })

  it('omits the row entirely when the tab is already a worktree', async () => {
    window.ion = {
      gitIsRepo: vi.fn().mockResolvedValue({ isRepo: true }),
      gitChanges: vi.fn().mockResolvedValue({ files: [] }),
    } as unknown as typeof window.ion

    await openMenu(tab({
      worktree: {
        worktreePath: '/repo-wt', branchName: 'wt/a3f1', sourceBranch: 'main', repoPath: '/repo',
      } as unknown as TabState['worktree'],
    }))

    expect(convertButton()).toBeUndefined()
  })

  it('omits the row when the working directory is not a git repo', async () => {
    window.ion = {
      gitIsRepo: vi.fn().mockResolvedValue({ isRepo: false }),
      gitChanges: vi.fn(),
    } as unknown as typeof window.ion

    await openMenu(tab())

    expect(convertButton()).toBeUndefined()
  })
})
