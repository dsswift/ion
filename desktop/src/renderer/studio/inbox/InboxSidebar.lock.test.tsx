// @vitest-environment jsdom
/**
 * InboxSidebar under the new-conversation lock: the New project button is the
 * one control here that adds a project, so it goes when a directory is locked.
 * The New conversation button stays: it opens straight into the locked folder.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const preferenceState = { inboxAutoSettleDays: 0, projects: {}, enterpriseNewConversationDefaults: null as null | { locked: boolean; baseDirectory: string; engineProfileId: string } }
const sessionState = { tabs: [], activeTabId: '', conversationPanes: new Map(), benchWorkspaces: new Map(), worktreeInventory: new Map(), settledHistory: [], refreshWorkspaceViews: vi.fn(), createTabInDirectory: vi.fn(), createConversationTab: vi.fn(), openSettings: vi.fn() }

vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: Object.assign((selector: (s: typeof sessionState) => unknown) => selector(sessionState), { getState: () => sessionState }) }))
vi.mock('../../preferences', () => ({ usePreferencesStore: Object.assign((selector: (s: typeof preferenceState) => unknown) => selector(preferenceState), { getState: () => preferenceState }) }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
vi.mock('./InboxRow', () => ({ InboxRow: () => React.createElement('div') }))
vi.mock('./InboxNavigatorGroups', () => ({ InboxNavigatorGroups: () => React.createElement('div') }))
vi.mock('./SettledHistoryView', () => ({ SettledHistoryView: () => React.createElement('div') }))
vi.mock('../../components/NewConversationPicker', () => ({ NewConversationPicker: () => React.createElement('div') }))
vi.mock('../new-project/NewProjectPanel', () => ({ NewProjectPanel: () => React.createElement('div') }))
vi.mock('../../components/conversation-status', () => ({ shouldUseWorktree: () => false, waitingStateOfPane: () => null }))
vi.mock('./InboxControls', () => ({ InboxControlButton: () => React.createElement('div'), InboxProjectScopePicker: () => React.createElement('div'), InboxSortPicker: () => React.createElement('div') }))

import { InboxSidebar } from './InboxSidebar'

let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
async function render(): Promise<void> {
  localStorage.clear()
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(React.createElement(InboxSidebar)) })
}
afterEach(() => { act(() => root.unmount()); container.remove(); preferenceState.enterpriseNewConversationDefaults = null })

describe('InboxSidebar new-project control', () => {
  it('offers New project and New conversation when nothing locks the folder', async () => {
    await render()
    expect(container.querySelector('[aria-label="New project"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="New conversation"]')).not.toBeNull()
  })

  it('offers no New project under a directory lock, and keeps New conversation', async () => {
    preferenceState.enterpriseNewConversationDefaults = { locked: true, baseDirectory: '/o', engineProfileId: 'orion' }
    await render()
    expect(container.querySelector('[aria-label="New project"]')).toBeNull()
    expect(container.querySelector('[aria-label="New conversation"]')).not.toBeNull()
  })
})
