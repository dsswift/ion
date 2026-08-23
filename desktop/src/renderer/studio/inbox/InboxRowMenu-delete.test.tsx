// @vitest-environment jsdom
/** Pins the inbox delete gate: the menu must never delete before a clear choice. */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = {
  benchWorkspaces: new Map(),
  unsnoozeTab: vi.fn(), snoozeTab: vi.fn(), markTabUnread: vi.fn(),
  pinTab: vi.fn(), unpinTab: vi.fn(),
  settleTab: vi.fn(async () => undefined), unsettleTab: vi.fn(async () => undefined),
  regenerateTabTitle: vi.fn(async () => undefined),
  deleteConversationTab: vi.fn(async () => undefined),
}
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))
vi.mock('../../theme', () => ({ useColors: () => ({
  dangerFg: '#ff0000', textPrimary: '#000000', textTertiary: '#777777',
  popoverBg: '#ffffff', popoverBorder: '#cccccc', popoverShadow: 'none',
  containerBorder: '#cccccc',
}) }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (value: { inboxAutoSettleDays: number }) => unknown) => selector({ inboxAutoSettleDays: 0 }),
}))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => null }))
vi.mock('../../components/useConvertToWorktreeGate', () => ({
  useConvertToWorktreeGate: () => ({ show: false, disabled: false, label: '' }),
}))
vi.mock('@phosphor-icons/react', () => ({ Trash: () => <span data-testid="trash-icon" /> }))

import { InboxRowMenu } from './InboxRowMenu'

const tab = {
  id: 'tab-1', conversationId: 'conversation-1', title: 'Important work', customTitle: null,
  status: 'idle', workingDirectory: '/repo', historicalSessionIds: [],
} as unknown as TabState
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

function button(label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  if (!match) throw new Error(`missing button ${label}`)
  return match
}

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<InboxRowMenu x={10} y={10} tab={tab} onRename={vi.fn()} onClose={vi.fn()} />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('InboxRowMenu delete confirmation', () => {
  it('marks delete as destructive and does not delete when the menu row is clicked', () => {
    const deleteButton = button('Delete conversation…')
    expect(deleteButton.style.color).toBe('rgb(255, 0, 0)')
    expect(deleteButton.querySelector('[data-testid="trash-icon"]')).not.toBeNull()

    act(() => { deleteButton.click() })

    expect(state.deleteConversationTab).not.toHaveBeenCalled()
    expect(button('Settle Conversation')).toBeDefined()
    expect(button('Delete Conversation')).toBeDefined()
    expect(button('Cancel')).toBeDefined()
  })

  it('settles without deleting when the safe choice is selected', () => {
    act(() => { button('Delete conversation…').click() })
    act(() => { button('Settle Conversation').click() })

    expect(state.settleTab).toHaveBeenCalledWith('tab-1')
    expect(state.deleteConversationTab).not.toHaveBeenCalled()
  })

  it('permanently deletes only after explicit confirmation', () => {
    act(() => { button('Delete conversation…').click() })
    act(() => { button('Delete Conversation').click() })

    expect(state.deleteConversationTab).toHaveBeenCalledWith('tab-1')
    expect(state.settleTab).not.toHaveBeenCalled()
  })

  it('does nothing when cancelled', () => {
    act(() => { button('Delete conversation…').click() })
    act(() => { button('Cancel').click() })

    expect(state.deleteConversationTab).not.toHaveBeenCalled()
    expect(state.settleTab).not.toHaveBeenCalled()
  })
})
