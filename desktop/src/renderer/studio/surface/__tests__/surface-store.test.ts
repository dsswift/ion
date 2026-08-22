// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openFileInEditorMock = vi.fn()
const sessionTabs: Array<{ id: string; workingDirectory: string; worktree?: { repoPath: string } }> = []
let activeSessionTabId: string | null = 'tab-1'
vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ openFileInEditor: openFileInEditorMock, tabs: sessionTabs, activeTabId: activeSessionTabId }) },
}))
vi.mock('../../../stores/session-store-helpers', () => ({
  editorDirForTab: (tab: { worktree?: { repoPath: string }; workingDirectory: string }) => tab.worktree?.repoPath ?? tab.workingDirectory,
}))
const preferences = { studioSurfaceSwitchMode: 'preserve' as 'preserve' | 'per-conversation' }
vi.mock('../../../preferences', () => ({
  usePreferencesStore: { getState: () => preferences },
}))

import { resetSurfaceHydrationForTests, useSurfaceStore } from '../surface-store'

const terminalDestroyMock = vi.fn().mockResolvedValue(undefined)
const setSettingMock = vi.fn().mockResolvedValue(true)
const getSettingsMock = vi.fn().mockResolvedValue({})

function resetStore(): void {
  resetSurfaceHydrationForTests()
  useSurfaceStore.setState({ tabs: [], activeTabId: null, pinnedTabs: ['plan'], notification: null, conversations: {}, currentConversationId: 'tab-1', visible: false, hydrated: true, diffReveal: null })
  useSurfaceStore.getState().selectConversation(null)
  useSurfaceStore.getState().selectConversation('tab-1')
}

beforeEach(() => {
  vi.useFakeTimers()
  openFileInEditorMock.mockClear()
  terminalDestroyMock.mockClear()
  setSettingMock.mockClear()
  preferences.studioSurfaceSwitchMode = 'preserve'
  activeSessionTabId = 'tab-1'
  sessionTabs.length = 0
  sessionTabs.push({ id: 'tab-1', workingDirectory: '/repo' }, { id: 'tab-2', workingDirectory: '/other' })
  ;(window as unknown as { ion: unknown }).ion = { terminalDestroy: terminalDestroyMock, studioSetSetting: setSettingMock, studioGetSettings: getSettingsMock }
  resetStore()
})
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

describe('surface-store', () => {
  it('keeps surface tabs and active selection separate per conversation', () => {
    const store = useSurfaceStore.getState()
    store.openSingleton('diff')
    store.openFileTab('/repo', 'tab-1', '/repo/a.ts')
    store.selectConversation('tab-2')
    expect(useSurfaceStore.getState().tabs.map((tab) => tab.id)).toEqual(['plan'])
    store.openSingleton('visualizer')
    store.selectConversation('tab-1')
    expect(useSurfaceStore.getState().tabs.map((tab) => tab.id)).toEqual(['plan', 'diff', 'file:/repo/a.ts'])
    expect(useSurfaceStore.getState().activeTabId).toBe('file:/repo/a.ts')
  })

  it('migrates v1 tabs into the active conversation and keeps the old panel visibility', async () => {
    resetSurfaceHydrationForTests()
    getSettingsMock.mockResolvedValueOnce({
      studioLayout: { surfaceVisible: true },
      studioSurface: { version: 1, tabs: [{ kind: 'singleton', id: 'diff' }], activeTabId: 'diff' },
    })
    await useSurfaceStore.getState().hydrate()
    const state = useSurfaceStore.getState()
    expect(state.pinnedTabs).toEqual(['plan'])
    expect(state.tabs.map((tab) => tab.id)).toEqual(['plan', 'diff'])
    expect(state.conversations['tab-1']?.visible).toBe(true)
  })

  it('opens and focuses a workspace notification over the active Plan tab', () => {
    const store = useSurfaceStore.getState()
    expect(store.activeTabId).toBe('plan')

    store.openResourceTab({ id: 'resource-1', kind: 'briefing' } as never)

    const state = useSurfaceStore.getState()
    expect(state.tabs.find((tab) => tab.id === 'notification')).toMatchObject({ resourceId: 'resource-1' })
    expect(state.activeTabId).toBe('notification')
    expect(state.conversations['tab-1']?.activeTabId).toBe('notification')
  })

  it('keeps a workspace notification open across conversations until closed', () => {
    const store = useSurfaceStore.getState()
    store.openResourceTab({ id: 'resource-1', kind: 'briefing' } as never)
    expect(useSurfaceStore.getState().tabs.find((tab) => tab.id === 'notification')).toMatchObject({ resourceId: 'resource-1' })
    store.selectConversation('tab-2')
    expect(useSurfaceStore.getState().tabs.find((tab) => tab.id === 'notification')).toMatchObject({ resourceId: 'resource-1' })
    store.openResourceTab({ id: 'resource-2', kind: 'briefing' } as never)
    store.openSingleton('diff')
    store.closeOthers('diff')
    expect(useSurfaceStore.getState().tabs.find((tab) => tab.id === 'notification')).toMatchObject({ resourceId: 'resource-2' })
    store.selectConversation('tab-1')
    expect(useSurfaceStore.getState().tabs.find((tab) => tab.id === 'notification')).toMatchObject({ resourceId: 'resource-2' })
    store.closeTab('notification')
    store.selectConversation('tab-2')
    expect(useSurfaceStore.getState().tabs.some((tab) => tab.id === 'notification')).toBe(false)
  })

  it('pins Plan by default and adds eligible tabs globally', () => {
    const store = useSurfaceStore.getState()
    expect(store.tabs.map((tab) => tab.id)).toEqual(['plan'])
    store.openSingleton('diff')
    store.pinTab('diff')
    store.selectConversation('tab-2')
    expect(useSurfaceStore.getState().tabs.map((tab) => tab.id)).toEqual(['diff', 'plan'])
  })

  it('carries the active pinned tab across a conversation switch instead of resetting to strip order', () => {
    const store = useSurfaceStore.getState()
    store.openSingleton('diff')
    store.pinTab('diff')
    // Diff sits before Plan in strip order (SINGLETON_ORDER), so a naive
    // fallback to the first pinned tab would land on Diff here.
    expect(useSurfaceStore.getState().tabs.map((tab) => tab.id)).toEqual(['diff', 'plan'])
    store.activateTab('plan')
    expect(useSurfaceStore.getState().activeTabId).toBe('plan')

    store.selectConversation('tab-2')
    expect(useSurfaceStore.getState().activeTabId).toBe('plan')

    store.selectConversation('tab-1')
    expect(useSurfaceStore.getState().activeTabId).toBe('plan')
  })

  it('unpin retains the tab only in the active conversation', () => {
    const store = useSurfaceStore.getState()
    store.unpinTab('plan')
    expect(useSurfaceStore.getState().tabs.map((tab) => tab.id)).toEqual(['plan'])
    store.selectConversation('tab-2')
    expect(useSurfaceStore.getState().tabs).toEqual([])
  })

  it('closing a pinned tab unpins and closes it in one action', () => {
    useSurfaceStore.getState().closeTab('plan')
    const state = useSurfaceStore.getState()
    expect(state.pinnedTabs).toEqual([])
    expect(state.tabs).toEqual([])
  })

  it('materializes a file buffer for the owning conversation', () => {
    useSurfaceStore.getState().openFileTab('/repo', 'tab-1', '/repo/a.ts')
    expect(openFileInEditorMock).toHaveBeenCalledWith('/repo', 'tab-1', '/repo/a.ts')
    expect(useSurfaceStore.getState().tabs.some((tab) => tab.id === 'file:/repo/a.ts')).toBe(true)
  })

  it('destroys a terminal only when explicitly closed', () => {
    useSurfaceStore.getState().openTerminalTab('/repo')
    const terminal = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'terminal')!
    useSurfaceStore.getState().selectConversation('tab-2')
    expect(terminalDestroyMock).not.toHaveBeenCalled()
    useSurfaceStore.getState().selectConversation('tab-1')
    useSurfaceStore.getState().closeTab(terminal.id)
    expect(terminalDestroyMock).toHaveBeenCalledWith(`studio:${(terminal as { instanceId: string }).instanceId}`)
  })

  it('keeps visibility live without changing saved conversation state in keep mode', () => {
    const store = useSurfaceStore.getState()
    store.setVisible(true)
    store.selectConversation('tab-2')
    store.setVisible(false)
    store.selectConversation('tab-1')
    expect(useSurfaceStore.getState().visible).toBe(false)
    expect(useSurfaceStore.getState().conversations['tab-1']?.visible).toBe(false)
  })

  it('restores and saves each conversation visibility in per-conversation mode', () => {
    preferences.studioSurfaceSwitchMode = 'per-conversation'
    const store = useSurfaceStore.getState()
    store.setVisible(true)
    store.selectConversation('tab-2')
    expect(useSurfaceStore.getState().visible).toBe(false)
    store.setVisible(true)
    store.selectConversation('tab-1')
    expect(useSurfaceStore.getState().visible).toBe(true)
    expect(useSurfaceStore.getState().conversations['tab-1']?.visible).toBe(true)
    expect(useSurfaceStore.getState().conversations['tab-2']?.visible).toBe(true)
  })

  it('persists v2 records through the studio settings funnel', () => {
    useSurfaceStore.getState().openSingleton('diff')
    vi.advanceTimersByTime(350)
    const [key, value] = setSettingMock.mock.calls[0] as [string, { version: number; pinnedTabs: string[]; conversations: Record<string, unknown> }]
    expect(key).toBe('studioSurface')
    expect(value.version).toBe(2)
    expect(value.pinnedTabs).toEqual(['plan'])
    expect(value.conversations).toHaveProperty('tab-1')
  })
})
