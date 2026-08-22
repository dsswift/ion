// @vitest-environment jsdom
/**
 * Regression: the inbox row's context-menu "Rename" button called
 * `window.prompt(...)`, which Electron's renderer never implements — it is a
 * silent no-op, so clicking Rename just closed the menu with no visible
 * effect. `InboxRow` already ships a working inline-rename input (triggered
 * on double-click); the menu's Rename button must trigger that same input
 * instead of the broken prompt.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renameTab = vi.fn()
const state = {
  activeTabId: null as string | null,
  conversationPanes: new Map(),
  // Always a Map on the real store. The row menu reads it to decide whether
  // the conversation lives in an integration bench, where Snooze is absent.
  benchWorkspaces: new Map(),
  selectTab: vi.fn(),
  renameTab,
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

function tab(workingDirectory = '/repo'): TabState {
  return {
    id: 'tab-1',
    conversationId: 'conv-1',
    title: 'My conversation',
    customTitle: null,
    status: 'idle',
    workingDirectory,
  } as TabState
}

/** Opens the row's context menu and returns the menu's button labels. */
async function menuLabels(t: TabState): Promise<string[]> {
  act(() => root.render(
    <InboxRow tab={t} unread={false} woke={false} projectName={null} variant="card" backgroundLiveness={null} />,
  ))
  const row = host.querySelector<HTMLDivElement>(`[data-inbox-tab-id="${t.id}"]`)!
  act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
  // Let the convert-to-worktree gate's gitIsRepo probe resolve so its state
  // update lands inside act(), matching how TabStripTabContextMenu.test.tsx
  // settles the same gate.
  await act(async () => { await Promise.resolve() })
  return Array.from(host.querySelectorAll('button')).map((b) => b.textContent ?? '')
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // The row menu now includes the same convert-to-worktree gate the tab-strip
  // menu uses, which probes window.ion.gitIsRepo on mount. Stub it closed
  // (not a repo) so these Rename/Snooze-focused tests are unaffected by it.
  window.ion = {
    gitIsRepo: vi.fn().mockResolvedValue({ isRepo: false }),
    gitChanges: vi.fn().mockResolvedValue({ files: [] }),
  } as unknown as typeof window.ion
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('InboxRow context-menu Rename', () => {
  it('opens the inline rename input instead of calling window.prompt', async () => {
    const promptSpy = vi.spyOn(window, 'prompt')
    const t = tab()
    act(() => root.render(
      <InboxRow tab={t} unread={false} woke={false} projectName={null} variant="card" backgroundLiveness={null} />,
    ))

    const row = host.querySelector<HTMLDivElement>(`[data-inbox-tab-id="${t.id}"]`)!
    act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
    // Let the convert-to-worktree gate's gitIsRepo probe resolve inside act().
    await act(async () => { await Promise.resolve() })

    const renameButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Rename')
    expect(renameButton).toBeDefined()
    act(() => { renameButton!.click() })

    // The inline input (pre-filled with the current title) must appear; the
    // broken prompt path must never fire.
    const input = host.querySelector<HTMLInputElement>('input')
    expect(input).not.toBeNull()
    expect(input!.value).toBe('My conversation')
    expect(promptSpy).not.toHaveBeenCalled()
  })
})

/**
 * A bench is rebuildable scratch space: the next assembly recreates its branch
 * and deletes every conversation in it, so parking one for later promises a
 * future that cannot arrive. The verb is ABSENT rather than disabled, matching
 * how every other unavailable affordance is treated.
 */
describe('InboxRow context-menu Snooze in an integration bench', () => {
  const BENCH = '/Users/dev/.ion/integration/ion-josh'

  beforeEach(() => {
    state.benchWorkspaces = new Map([['/Users/dev/src/ion', [{ benchPath: BENCH }]]]) as typeof state.benchWorkspaces
  })
  afterEach(() => {
    state.benchWorkspaces = new Map()
  })

  it('omits Snooze for a conversation in the bench', async () => {
    expect((await menuLabels(tab(BENCH))).some((label) => label.startsWith('Snooze'))).toBe(false)
  })

  it('omits Snooze for a conversation nested inside the bench', async () => {
    expect((await menuLabels(tab(`${BENCH}/desktop`))).some((label) => label.startsWith('Snooze'))).toBe(false)
  })

  it('still offers Snooze outside the bench', async () => {
    expect((await menuLabels(tab('/Users/dev/src/ion'))).some((label) => label.startsWith('Snooze'))).toBe(true)
  })
})
