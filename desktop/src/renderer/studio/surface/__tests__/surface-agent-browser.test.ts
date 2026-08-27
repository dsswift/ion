// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sessionTabs: Array<{ id: string; workingDirectory: string }> = []
let activeSessionTabId: string | null = 'tab-1'
vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ openFileInEditor: vi.fn(), tabs: sessionTabs, activeTabId: activeSessionTabId }) },
}))
vi.mock('../../../stores/session-store-helpers', () => ({
  editorDirForTab: (tab: { workingDirectory: string }) => tab.workingDirectory,
}))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ studioSurfaceSwitchMode: 'preserve' }) },
}))

import { flushSurfacePersist, resetSurfaceHydrationForTests, useSurfaceStore } from '../surface-store'

function browserInstances(): string[] {
  return useSurfaceStore.getState().tabs.flatMap((tab) => (tab.kind === 'browser' ? [tab.instanceId] : []))
}
function pointer(conversationId = 'tab-1'): string | null {
  return useSurfaceStore.getState().conversations[conversationId]?.agentBrowserInstanceId ?? null
}

beforeEach(() => {
  vi.useFakeTimers()
  sessionTabs.length = 0
  sessionTabs.push({ id: 'tab-1', workingDirectory: '/repo' }, { id: 'tab-2', workingDirectory: '/other' })
  activeSessionTabId = 'tab-1'
  ;(window as unknown as { ion: unknown }).ion = {
    terminalDestroy: vi.fn().mockResolvedValue(undefined),
    studioBrowserViewEnsure: vi.fn().mockResolvedValue(true),
    studioBrowserViewBounds: vi.fn(),
    studioBrowserViewNavigate: vi.fn().mockResolvedValue(true),
    studioBrowserViewAction: vi.fn().mockResolvedValue(true),
    studioBrowserViewClose: vi.fn().mockResolvedValue(true),
    onStudioBrowserViewState: vi.fn(() => () => undefined),
    studioSetSetting: vi.fn().mockResolvedValue(true),
    studioGetSettings: vi.fn().mockResolvedValue({}),
  }
  resetSurfaceHydrationForTests()
  useSurfaceStore.setState({ tabs: [], activeTabId: null, pinnedTabs: [], notification: null, conversations: {}, currentConversationId: 'tab-1', visible: false, hydrated: true, diffReveal: null })
  useSurfaceStore.getState().selectConversation(null)
  useSurfaceStore.getState().selectConversation('tab-1')
})
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

describe('agent browser link', () => {
  it('links the first browser tab and leaves later ones unlinked', () => {
    const store = useSurfaceStore.getState()
    store.openBrowserTab('https://a.test', 'browse')
    const first = pointer()
    expect(first).not.toBeNull()

    store.openBrowserTab('https://b.test', 'browse')
    // The operator's second tab is their own. Stealing the link here would
    // move the agent off the page it was already working on.
    expect(pointer()).toBe(first)
    expect(browserInstances()).toHaveLength(2)
  })

  it('sorts the linked tab first and follows an explicit reassignment', () => {
    const store = useSurfaceStore.getState()
    store.openBrowserTab('https://a.test', 'browse')
    store.openBrowserTab('https://b.test', 'browse')
    const [firstInstance, secondInstance] = browserInstances()

    useSurfaceStore.getState().linkAgentBrowser(secondInstance!)
    expect(pointer()).toBe(secondInstance)
    // Reassignment is atomic: pointer, ordering, and selection all move.
    expect(browserInstances()).toEqual([secondInstance, firstInstance])
    expect(useSurfaceStore.getState().activeTabId).toBe(`browser:${secondInstance}`)
  })

  it('ignores a link request for a tab in another conversation', () => {
    const store = useSurfaceStore.getState()
    store.openBrowserTab('https://a.test', 'browse')
    const own = pointer()
    store.selectConversation('tab-2')
    useSurfaceStore.getState().openBrowserTab('https://other.test', 'browse')
    const foreign = pointer('tab-2')

    useSurfaceStore.getState().selectConversation('tab-1')
    useSurfaceStore.getState().linkAgentBrowser(foreign!)
    expect(pointer()).toBe(own)
  })

  it('clears the pointer on close without adopting another tab', () => {
    const store = useSurfaceStore.getState()
    store.openBrowserTab('https://a.test', 'browse')
    const linked = pointer()
    useSurfaceStore.getState().openBrowserTab('https://prepared.test', 'browse')

    useSurfaceStore.getState().closeTab(`browser:${linked}`)
    // The remaining tab may be a page the operator signed into for
    // themselves. It must NOT inherit the agent link just because the linked
    // tab closed.
    expect(pointer()).toBeNull()
    expect(browserInstances()).toHaveLength(1)
  })

  it('creates exactly one tab when the agent needs a browser', () => {
    const created = useSurfaceStore.getState().ensureAgentBrowser('tab-1', 'https://target.test')
    expect(created?.agentLinked).toBe(true)
    expect(browserInstances()).toEqual([created!.instanceId])
    expect(useSurfaceStore.getState().visible).toBe(true)
  })

  it('reuses and navigates the linked tab instead of opening a second one', () => {
    const first = useSurfaceStore.getState().ensureAgentBrowser('tab-1', 'https://one.test')
    const again = useSurfaceStore.getState().ensureAgentBrowser('tab-1', 'https://two.test')

    expect(again?.instanceId).toBe(first?.instanceId)
    expect(browserInstances()).toHaveLength(1)
    expect(again?.url).toBe('https://two.test')
  })

  it('adopts an existing unlinked tab only when the operator asks', () => {
    const store = useSurfaceStore.getState()
    store.openBrowserTab('https://a.test', 'browse')
    const linked = pointer()
    useSurfaceStore.getState().openBrowserTab('https://prepared.test', 'browse')
    const prepared = browserInstances().find((id) => id !== linked)!
    useSurfaceStore.getState().closeTab(`browser:${linked}`)

    useSurfaceStore.getState().linkAgentBrowser(prepared)
    // Same tab the auto-adopt rule refused to take — reachable, but only
    // through a deliberate operator action.
    expect(useSurfaceStore.getState().agentBrowser('tab-1')?.instanceId).toBe(prepared)
  })

  it('reports no agent browser before one is linked', () => {
    expect(useSurfaceStore.getState().agentBrowser('tab-1')).toBeNull()
  })

  it('stores and clears a browser emulation state', () => {
    const created = useSurfaceStore.getState().ensureAgentBrowser('tab-1', 'https://target.test')
    useSurfaceStore.getState().setBrowserEmulation('tab-1', created!.instanceId, { device: 'iPhone 15', width: 393, height: 852 })
    expect(useSurfaceStore.getState().agentBrowser('tab-1')?.emulation).toMatchObject({ device: 'iPhone 15', width: 393 })

    useSurfaceStore.getState().setBrowserEmulation('tab-1', created!.instanceId, null)
    expect(useSurfaceStore.getState().agentBrowser('tab-1')?.emulation).toBeNull()
  })

  it('keeps the link and emulation across a session-mode flip', () => {
    const created = useSurfaceStore.getState().ensureAgentBrowser('tab-1', 'https://target.test')
    useSurfaceStore.getState().setBrowserEmulation('tab-1', created!.instanceId, { width: 390, height: 844 })
    useSurfaceStore.getState().updateBrowserTab(`browser:${created!.instanceId}`, { sessionMode: 'isolated' })

    const after = useSurfaceStore.getState().agentBrowser('tab-1')
    expect(after?.instanceId).toBe(created!.instanceId)
    expect(after?.sessionMode).toBe('isolated')
    expect(after?.emulation).toMatchObject({ width: 390, height: 844 })
  })
})

describe('background conversations', () => {
  it('creates and links a tab for a conversation that is not on screen', () => {
    // The whole point: an agent working in tab-2 while the operator looks at
    // tab-1 must get its own browser without a context switch.
    useSurfaceStore.getState().selectConversation('tab-1')
    const created = useSurfaceStore.getState().ensureAgentBrowser('tab-2', 'https://background.test')

    expect(created?.agentLinked).toBe(true)
    expect(pointer('tab-2')).toBe(created!.instanceId)
    // tab-1 is untouched.
    expect(pointer('tab-1')).toBeNull()
  })

  it('does not steal the operator view or selection', () => {
    useSurfaceStore.getState().selectConversation('tab-1')
    useSurfaceStore.getState().openBrowserTab('https://foreground.test', 'browse')
    const before = useSurfaceStore.getState().activeTabId
    const visibleBefore = useSurfaceStore.getState().visible

    useSurfaceStore.getState().ensureAgentBrowser('tab-2', 'https://background.test')

    // A background agent must not yank the panel or change what is selected.
    expect(useSurfaceStore.getState().currentConversationId).toBe('tab-1')
    expect(useSurfaceStore.getState().activeTabId).toBe(before)
    expect(useSurfaceStore.getState().visible).toBe(visibleBefore)
  })

  it('keeps the background tab out of the visible strip', () => {
    useSurfaceStore.getState().selectConversation('tab-1')
    useSurfaceStore.getState().ensureAgentBrowser('tab-2', 'https://background.test')
    // Stored on tab-2, absent from what tab-1 renders.
    expect(browserInstances()).toHaveLength(0)
    expect(useSurfaceStore.getState().conversations['tab-2']?.tabs).toHaveLength(1)
  })

  it('reuses the background tab instead of opening a second one', () => {
    useSurfaceStore.getState().selectConversation('tab-1')
    const first = useSurfaceStore.getState().ensureAgentBrowser('tab-2', 'https://one.test')
    const again = useSurfaceStore.getState().ensureAgentBrowser('tab-2', 'https://two.test')

    expect(again?.instanceId).toBe(first?.instanceId)
    expect(useSurfaceStore.getState().conversations['tab-2']?.tabs).toHaveLength(1)
    expect(again?.url).toBe('https://two.test')
  })

  it('reads and emulates a background tab by conversation', () => {
    useSurfaceStore.getState().selectConversation('tab-1')
    const created = useSurfaceStore.getState().ensureAgentBrowser('tab-2', 'https://background.test')
    useSurfaceStore.getState().setBrowserEmulation('tab-2', created!.instanceId, { width: 390, height: 844 })

    expect(useSurfaceStore.getState().agentBrowser('tab-2')?.emulation).toMatchObject({ width: 390 })
    // Without an id it still answers for the visible conversation, which has
    // no browser at all.
    expect(useSurfaceStore.getState().agentBrowser('tab-1')).toBeNull()
  })

  it('shows the background tab once the operator switches to it', () => {
    useSurfaceStore.getState().selectConversation('tab-1')
    const created = useSurfaceStore.getState().ensureAgentBrowser('tab-2', 'https://background.test')
    useSurfaceStore.getState().selectConversation('tab-2')
    // The work done while it was hidden is intact and now rendered.
    expect(browserInstances()).toEqual([created!.instanceId])
  })
})

describe('persist on quit', () => {
  it('writes pending surface state instead of losing it', () => {
    const setSetting = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { ion: Record<string, unknown> }).ion.studioSetSetting = setSetting

    useSurfaceStore.getState().openBrowserTab('https://about-to-quit.test', 'browse')
    // The write is debounced, so nothing has reached disk yet. A quit here is
    // exactly how a just-opened tab came back missing after a restart.
    expect(setSetting).not.toHaveBeenCalled()

    flushSurfacePersist()

    expect(setSetting).toHaveBeenCalledWith('studioSurface', expect.objectContaining({ version: 3 }))
    const written = setSetting.mock.calls[0]![1] as { conversations: Record<string, { tabs: { kind: string }[] }> }
    expect(written.conversations['tab-1']?.tabs.some((tab) => tab.kind === 'browser')).toBe(true)
  })

  it('does nothing when there is no pending write', () => {
    const setSetting = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { ion: Record<string, unknown> }).ion.studioSetSetting = setSetting
    flushSurfacePersist()
    // Flushing an idle store would write on every window close for no reason.
    expect(setSetting).not.toHaveBeenCalled()
  })
})

describe('panel visibility survives a restart', () => {
  it('records the panel state in preserve mode', () => {
    // The bug: setVisible only wrote the flag in per-conversation mode, so a
    // 'preserve' operator always reopened Ion with the panel closed no matter
    // how they left it. The mode governs how a tab SWITCH reads this, not
    // whether it is ever written.
    useSurfaceStore.getState().setVisible(true)
    expect(useSurfaceStore.getState().conversations['tab-1']?.visible).toBe(true)

    useSurfaceStore.getState().setVisible(false)
    expect(useSurfaceStore.getState().conversations['tab-1']?.visible).toBe(false)
  })

  it('serializes the recorded state so a restart can read it', () => {
    const setSetting = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { ion: Record<string, unknown> }).ion.studioSetSetting = setSetting

    useSurfaceStore.getState().openBrowserTab('https://www.google.com', 'browse')
    useSurfaceStore.getState().setVisible(true)
    flushSurfacePersist()

    const written = setSetting.mock.calls.at(-1)![1] as { conversations: Record<string, { visible: boolean; tabs: { kind: string }[] }> }
    // Both halves of the reported failure: the tab AND the open panel.
    expect(written.conversations['tab-1']?.visible).toBe(true)
    expect(written.conversations['tab-1']?.tabs.some((tab) => tab.kind === 'browser')).toBe(true)
  })
})

describe('panel visibility at boot', () => {
  it('keeps the restored panel open when selection runs before hydration', () => {
    // The conversation-sync subscription fires at boot BEFORE hydrate()
    // resolves. In 'keep' mode selection carries `state.visible` across a
    // switch, which pre-hydration is the store's `false` default rather than
    // anything the operator chose — so it overwrote the restored value and the
    // panel always came back closed with the browser tab inside it.
    useSurfaceStore.setState({
      hydrated: false,
      visible: false,
      conversations: { 'tab-1': { tabs: [], activeTabId: 'plan', visible: true, agentBrowserInstanceId: null } },
    })

    useSurfaceStore.getState().selectConversation('tab-1')
    expect(useSurfaceStore.getState().visible).toBe(true)
  })

  it('still carries live visibility across a switch once hydrated', () => {
    // The pre-hydration guard must not change what 'keep' means afterwards.
    useSurfaceStore.setState({
      hydrated: true,
      visible: false,
      conversations: { 'tab-2': { tabs: [], activeTabId: 'plan', visible: true, agentBrowserInstanceId: null } },
    })

    useSurfaceStore.getState().selectConversation('tab-2')
    expect(useSurfaceStore.getState().visible).toBe(false)
  })
})
