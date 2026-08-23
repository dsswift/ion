import { beforeEach, describe, expect, it, vi } from 'vitest'

let sessionState: { activeTabId: string | null }
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => sessionState },
  editorDirForTab: (tab: { workingDirectory?: string }) => tab?.workingDirectory ?? '',
}))
vi.mock('../../preferences', () => ({ usePreferencesStore: { getState: () => ({}) } }))
vi.mock('../../preferences-types', async () => vi.importActual('../../preferences-types'))
vi.mock('../../../shared/tab-predicates', () => ({ tabHasExtensions: () => false }))

beforeEach(() => { sessionState = { activeTabId: 'tab-1' } })

describe('handleNewConversationShortcut', () => {
  it('always opens the unified picker and does not preselect a directory', async () => {
    const { handleNewConversationShortcut } = await import('../useKeyboardShortcuts')
    const events: Event[] = []
    handleNewConversationShortcut('/projects/ion', 'Cmd+T', (event) => events.push(event))

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('ion:open-new-conversation-picker')
    expect((events[0] as CustomEvent).detail).toBeNull()
  })
})
