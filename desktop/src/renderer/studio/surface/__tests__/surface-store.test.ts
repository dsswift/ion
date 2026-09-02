// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openFileInEditorMock = vi.fn()
const fileEditorStates = new Map<string, { files: Array<{ fileName: string }> }>()
const sessionTabs: Array<{ id: string; workingDirectory: string; worktree?: { repoPath: string } }> = []
let activeSessionTabId: string | null = 'tab-1'
vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ openFileInEditor: openFileInEditorMock, fileEditorStates, tabs: sessionTabs, activeTabId: activeSessionTabId }) },
}))
vi.mock('../../../stores/session-store-helpers', () => ({
  editorDirForTab: (tab: { worktree?: { repoPath: string }; workingDirectory: string }) => tab.worktree?.repoPath ?? tab.workingDirectory,
  nextUntitledNameFromNames: (names: Iterable<string>) => {
    const used = new Set(names)
    let number = 1
    while (used.has(`Untitled-${number}.md`)) number++
    return `Untitled-${number}.md`
  },
}))
const preferences = { studioSurfaceSwitchMode: 'preserve' as 'preserve' | 'per-conversation', editorWordWrap: true }
vi.mock('../../../preferences', () => ({
  usePreferencesStore: { getState: () => preferences },
}))

import { flushSurfacePersist, resetSurfaceHydrationForTests, useSurfaceStore } from '../surface-store'

const terminalDestroyMock = vi.fn().mockResolvedValue(undefined)
const setSettingMock = vi.fn().mockResolvedValue(true)
const getSettingsMock = vi.fn().mockResolvedValue({})

function resetStore(): void {
  resetSurfaceHydrationForTests()
  useSurfaceStore.setState({ tabs: [], activeTabId: null, pinnedTabs: ['plan'], notification: null, scratchProjects: {}, conversations: {}, currentConversationId: 'tab-1', pendingScratchCloseId: null, visible: false, hydrated: true, diffReveal: null })
  useSurfaceStore.getState().selectConversation(null)
  useSurfaceStore.getState().selectConversation('tab-1')
}

beforeEach(() => {
  vi.useFakeTimers()
  openFileInEditorMock.mockClear()
  terminalDestroyMock.mockClear()
  setSettingMock.mockClear()
  preferences.studioSurfaceSwitchMode = 'preserve'
  preferences.editorWordWrap = true
  activeSessionTabId = 'tab-1'
  sessionTabs.length = 0
  sessionTabs.push({ id: 'tab-1', workingDirectory: '/repo' }, { id: 'tab-2', workingDirectory: '/other' })
  ;(window as unknown as { ion: unknown }).ion = { terminalDestroy: terminalDestroyMock, studioSetSetting: setSettingMock, studioGetSettings: getSettingsMock }
  resetStore()
})
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

describe('surface-store', () => {
  it('keeps each conversation active tab when both have local selections', () => {
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

  it('restores each conversation active tab even when the other conversation uses a global pin', () => {
    const store = useSurfaceStore.getState()
    store.openDispatchTab('dev-lead', 'dispatch-1', 'Dev Lead')
    expect(useSurfaceStore.getState().activeTabId).toBe('dispatch-preview')

    store.selectConversation('tab-2')
    expect(useSurfaceStore.getState().activeTabId).toBe('plan')
    store.selectConversation('tab-1')

    expect(useSurfaceStore.getState().activeTabId).toBe('dispatch-preview')
    expect(useSurfaceStore.getState().tabs.filter((tab) => tab.kind === 'dispatch')).toHaveLength(1)
  })

  it('reuses the conversation dispatch preview tab for a later dispatch click', () => {
    const store = useSurfaceStore.getState()
    store.openDispatchTab('dev-lead', 'dispatch-1', 'Dev Lead')
    store.openDispatchTab('test-lead', 'dispatch-2', 'Test Lead')

    const dispatchTabs = useSurfaceStore.getState().tabs.filter((tab) => tab.kind === 'dispatch')
    expect(dispatchTabs).toEqual([{
      kind: 'dispatch',
      id: 'dispatch-preview',
      agentName: 'test-lead',
      dispatchId: 'dispatch-2',
      title: 'Test Lead',
    }])
    expect(useSurfaceStore.getState().activeTabId).toBe('dispatch-preview')
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
    expect(useSurfaceStore.getState().tabs.map((tab) => tab.id)).toEqual(['plan', 'diff'])
  })

  it('does not carry the active pinned tab into another conversation', () => {
    const store = useSurfaceStore.getState()
    store.openSingleton('diff')
    store.pinTab('diff')
    // Plan sits first in strip order. The new conversation has no saved
    // selection, so it starts at Plan without changing tab-1's saved Plan tab.
    expect(useSurfaceStore.getState().tabs.map((tab) => tab.id)).toEqual(['plan', 'diff'])
    store.activateTab('plan')
    expect(useSurfaceStore.getState().activeTabId).toBe('plan')

    store.selectConversation('tab-2')
    expect(useSurfaceStore.getState().activeTabId).toBe('plan')
    store.activateTab('diff')

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

  it('shares Scratch Documents across a source checkout and its worktrees', () => {
    sessionTabs.splice(0, sessionTabs.length,
      { id: 'source', workingDirectory: '/repo' },
      { id: 'worktree-a', workingDirectory: '/worktrees/a', worktree: { repoPath: '/repo' } },
      { id: 'worktree-b', workingDirectory: '/worktrees/b', worktree: { repoPath: '/repo' } },
      { id: 'other', workingDirectory: '/other' },
    )
    activeSessionTabId = 'worktree-a'
    useSurfaceStore.getState().selectConversation('worktree-a')
    useSurfaceStore.getState().createScratch()
    const scratch = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'scratch')
    expect(scratch).toMatchObject({ projectKey: '/repo', fileName: 'Untitled-1.md' })
    expect(setSettingMock).not.toHaveBeenCalled()

    flushSurfacePersist()

    expect(setSettingMock).toHaveBeenCalledWith('studioSurface', expect.objectContaining({
      version: 4,
      scratchProjects: expect.objectContaining({ '/repo': expect.any(Object) }),
    }))

    useSurfaceStore.getState().selectConversation('source')
    expect(useSurfaceStore.getState().tabs.some((tab) => tab.id === scratch?.id)).toBe(true)
    useSurfaceStore.getState().selectConversation('worktree-b')
    expect(useSurfaceStore.getState().tabs.some((tab) => tab.id === scratch?.id)).toBe(true)
    useSurfaceStore.getState().selectConversation('other')
    expect(useSurfaceStore.getState().tabs.some((tab) => tab.kind === 'scratch')).toBe(false)
  })

  it('reads the same content from every source-project conversation', () => {
    sessionTabs.splice(0, sessionTabs.length,
      { id: 'source', workingDirectory: '/repo' },
      { id: 'worktree-a', workingDirectory: '/worktrees/a', worktree: { repoPath: '/repo' } },
    )
    activeSessionTabId = 'source'
    useSurfaceStore.getState().selectConversation('source')
    useSurfaceStore.getState().createScratch()
    const created = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'scratch')!
    if (created.kind !== 'scratch') throw new Error('scratch tab missing')
    useSurfaceStore.getState().updateScratch(created.projectKey, created.documentId, 'shared body')

    // The reader is the surface tab a sibling conversation composes for itself:
    // its projectKey is what ScratchSurface passes to look the document up.
    activeSessionTabId = 'worktree-a'
    useSurfaceStore.getState().selectConversation('worktree-a')
    const sibling = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'scratch')!
    if (sibling.kind !== 'scratch') throw new Error('sibling scratch tab missing')
    const document = useSurfaceStore.getState().scratchProjects[sibling.projectKey]?.documents
      .find((doc) => doc.id === sibling.documentId)
    expect(document?.content).toBe('shared body')
  })

  it('re-activates a Scratch tab after another tab was visited', () => {
    const store = useSurfaceStore.getState()
    store.createScratch()
    const scratch = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'scratch')!
    expect(useSurfaceStore.getState().activeTabId).toBe(scratch.id)

    // Move focus off the scratch tab, then click back onto it. Scratch tabs
    // live in the global scratchProjects map, not conversation.tabs, so the
    // activation guard has to compose them in — before the fix this was a
    // no-op and the active tab stayed on 'plan'.
    store.openSingleton('plan')
    expect(useSurfaceStore.getState().activeTabId).toBe('plan')
    store.activateTab(scratch.id)
    expect(useSurfaceStore.getState().activeTabId).toBe(scratch.id)
  })

  it('activates a Scratch tab from another conversation in the same project', () => {
    sessionTabs.splice(0, sessionTabs.length,
      { id: 'source', workingDirectory: '/repo' },
      { id: 'worktree-a', workingDirectory: '/worktrees/a', worktree: { repoPath: '/repo' } },
    )
    activeSessionTabId = 'source'
    const store = useSurfaceStore.getState()
    store.selectConversation('source')
    store.createScratch()
    const scratch = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'scratch')!

    store.selectConversation('worktree-a')
    // The shared scratch tab is visible here; clicking it must activate it.
    expect(useSurfaceStore.getState().tabs.some((tab) => tab.id === scratch.id)).toBe(true)
    store.activateTab(scratch.id)
    expect(useSurfaceStore.getState().activeTabId).toBe(scratch.id)
  })

  it('keeps a Scratch Document after its creating conversation disappears', () => {
    useSurfaceStore.getState().createScratch()
    const scratch = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'scratch')
    sessionTabs.splice(0, 1)
    activeSessionTabId = 'tab-2'
    sessionTabs[0]!.workingDirectory = '/repo'
    useSurfaceStore.getState().selectConversation('tab-2')

    expect(useSurfaceStore.getState().tabs.some((tab) => tab.id === scratch?.id)).toBe(true)
  })

  it('requires confirmation before discarding a dirty Scratch Document', () => {
    useSurfaceStore.getState().createScratch()
    const scratch = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'scratch')!
    if (scratch.kind !== 'scratch') throw new Error('scratch tab missing')
    useSurfaceStore.getState().updateScratch(scratch.projectKey, scratch.documentId, 'keep me')

    useSurfaceStore.getState().closeTab(scratch.id)
    expect(useSurfaceStore.getState().pendingScratchCloseId).toBe(scratch.documentId)
    expect(useSurfaceStore.getState().scratchProjects[scratch.projectKey]?.documents).toHaveLength(1)

    useSurfaceStore.getState().confirmScratchClose()
    expect(useSurfaceStore.getState().scratchProjects[scratch.projectKey]).toBeUndefined()
  })

  it('promotes a Scratch Document into only the active conversation', () => {
    useSurfaceStore.getState().createScratch()
    const scratch = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'scratch')!
    if (scratch.kind !== 'scratch') throw new Error('scratch tab missing')

    useSurfaceStore.getState().promoteScratch(scratch.projectKey, scratch.documentId, '/repo/notes.md', 'tab-1')

    expect(useSurfaceStore.getState().scratchProjects[scratch.projectKey]).toBeUndefined()
    expect(openFileInEditorMock).toHaveBeenCalledWith('/repo', 'tab-1', '/repo/notes.md')
    expect(useSurfaceStore.getState().conversations['tab-1']?.tabs).toContainEqual(expect.objectContaining({ kind: 'file', filePath: '/repo/notes.md' }))
    expect(useSurfaceStore.getState().conversations['tab-2']?.tabs ?? []).not.toContainEqual(expect.objectContaining({ filePath: '/repo/notes.md' }))
  })

  it('keeps the save target fixed if the active conversation changes during Save', () => {
    sessionTabs[1]!.workingDirectory = '/repo'
    useSurfaceStore.getState().createScratch()
    const scratch = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'scratch')!
    if (scratch.kind !== 'scratch') throw new Error('scratch tab missing')
    useSurfaceStore.getState().selectConversation('tab-2')

    useSurfaceStore.getState().promoteScratch(scratch.projectKey, scratch.documentId, '/repo/notes.md', 'tab-1')

    expect(openFileInEditorMock).toHaveBeenCalledWith('/repo', 'tab-1', '/repo/notes.md')
    expect(useSurfaceStore.getState().conversations['tab-1']?.tabs).toContainEqual(expect.objectContaining({ filePath: '/repo/notes.md' }))
    expect(useSurfaceStore.getState().conversations['tab-2']?.tabs ?? []).not.toContainEqual(expect.objectContaining({ filePath: '/repo/notes.md' }))
  })

  it('creates browse tabs with a shared browser session by default', () => {
    useSurfaceStore.getState().openBrowserTab('https://example.org', 'browse')

    expect(useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'browser')).toMatchObject({
      mode: 'browse',
      sessionMode: 'shared',
    })
  })

  it('destroys a terminal only when explicitly closed', () => {
    useSurfaceStore.getState().openTerminalTab('/repo')
    const terminal = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'terminal')!
    useSurfaceStore.getState().selectConversation('tab-2')
    expect(terminalDestroyMock).not.toHaveBeenCalled()
    useSurfaceStore.getState().selectConversation('tab-1')
    useSurfaceStore.getState().closeTab(terminal.id)
    expect(terminalDestroyMock).toHaveBeenCalledWith(`tab-1:surface:${(terminal as { instanceId: string }).instanceId}`)
  })

  it('carries live visibility across a switch in keep mode', () => {
    const store = useSurfaceStore.getState()
    store.setVisible(true)
    store.selectConversation('tab-2')
    store.setVisible(false)
    store.selectConversation('tab-1')
    // This is what 'keep' means: the panel stays as the operator last left it
    // rather than snapping back to each conversation's own saved state.
    expect(useSurfaceStore.getState().visible).toBe(false)
  })

  it('still records each conversation state in keep mode', () => {
    const store = useSurfaceStore.getState()
    store.setVisible(true)
    store.selectConversation('tab-2')
    store.setVisible(false)
    // Recording and restoring are different questions. This test previously
    // asserted the record stayed unwritten, which is why a 'keep' operator
    // always reopened the app with the panel closed: there was nothing on disk
    // to restore. The switch behaviour above is unaffected by writing it.
    expect(useSurfaceStore.getState().conversations['tab-1']?.visible).toBe(true)
    expect(useSurfaceStore.getState().conversations['tab-2']?.visible).toBe(false)
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

  it('persists an explicitly selected browser session mode', () => {
    const store = useSurfaceStore.getState()
    store.openBrowserTab('https://example.org', 'browse')
    const browser = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'browser')
    expect(browser).toMatchObject({ sessionMode: 'shared' })

    if (!browser || browser.kind !== 'browser') throw new Error('browser tab missing')
    store.updateBrowserTab(browser.id, { sessionMode: 'isolated' })
    expect(useSurfaceStore.getState().tabs.find((tab) => tab.id === browser.id)).toMatchObject({ sessionMode: 'isolated' })
  })

  it('mounts browser descriptors for inactive conversations', () => {
    const store = useSurfaceStore.getState()
    store.openBrowserTab('https://example.org', 'browse')
    store.selectConversation('tab-2')
    store.openBrowserTab('https://example.net', 'browse', 'shared')
    expect(useSurfaceStore.getState().conversations['tab-1']?.tabs).toMatchObject([{ kind: 'browser' }])
    expect(useSurfaceStore.getState().conversations['tab-2']?.tabs).toMatchObject([{ kind: 'browser', sessionMode: 'shared' }])
  })

  it('persists v3 records through the studio settings funnel', () => {
    useSurfaceStore.getState().openSingleton('diff')
    vi.advanceTimersByTime(350)
    const [key, value] = setSettingMock.mock.calls[0] as [string, { version: number; pinnedTabs: string[]; conversations: Record<string, unknown> }]
    expect(key).toBe('studioSurface')
    expect(value.version).toBe(4)
    expect(value.pinnedTabs).toEqual(['plan'])
    expect(value.conversations).toHaveProperty('tab-1')
  })
})
