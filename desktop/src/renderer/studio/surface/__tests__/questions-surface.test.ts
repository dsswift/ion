// @vitest-environment jsdom
/**
 * Questions Canvas singleton tests — pins the Studio-side rules from the
 * guided-questions plan: forced-first composition (before global pins),
 * close refusal in every close verb, pane-hide refusal during a live
 * workflow, focus restore on retirement, and exclusion from persistence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../rendererLogger', () => ({
  rTrace: vi.fn(), rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(),
}))
vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ openFileInEditor: vi.fn(), tabs: [], activeTabId: 'conv-1' }) },
}))
vi.mock('../../../stores/session-store-helpers', () => ({
  editorDirForTab: (tab: { workingDirectory: string }) => tab.workingDirectory,
}))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ studioSurfaceSwitchMode: 'preserve' }) },
}))

import { resetSurfaceHydrationForTests, useSurfaceStore } from '../surface-store'
import { QUESTIONS_SURFACE_ID } from '../../../../shared/studio-surface-types'
import { serializeSurface } from '../../../../shared/studio-surface-persistence'

const studioSetSetting = vi.fn().mockResolvedValue(true)
beforeEach(() => {
  ;(window as unknown as { ion: unknown }).ion = {
    studioSetSetting,
    studioGetSettings: vi.fn().mockResolvedValue(null),
    terminalDestroy: vi.fn().mockResolvedValue(undefined),
    studioBrowserViewEnsure: vi.fn().mockResolvedValue(true),
    studioBrowserViewBounds: vi.fn(),
    studioBrowserViewNavigate: vi.fn().mockResolvedValue(true),
    studioBrowserViewAction: vi.fn().mockResolvedValue(true),
    studioBrowserViewClose: vi.fn().mockResolvedValue(true),
    onStudioBrowserViewState: vi.fn(() => () => undefined),
  }
  resetSurfaceHydrationForTests()
  useSurfaceStore.setState({
    tabs: [],
    activeTabId: null,
    pinnedTabs: ['plan'],
    notification: null,
    conversations: {},
    currentConversationId: 'conv-1',
    visible: false,
    hydrated: true,
    questionsConversations: new Set<string>(),
    questionsPriorActive: {},
  })
  useSurfaceStore.getState().selectConversation('conv-1')
})

describe('questions Canvas singleton', () => {
  it('showQuestionsSurface inserts the tab FIRST (before global pins), activates it, and opens the pane', () => {
    useSurfaceStore.getState().showQuestionsSurface('conv-1')
    const s = useSurfaceStore.getState()
    expect(s.tabs[0]).toEqual({ kind: 'questions', id: QUESTIONS_SURFACE_ID })
    // The pin ('plan') comes after the forced group.
    expect(s.tabs[1]?.id).toBe('plan')
    expect(s.activeTabId).toBe(QUESTIONS_SURFACE_ID)
    expect(s.visible).toBe(true)
  })

  it('closeTab refuses the questions tab; closeOthers spares it', () => {
    useSurfaceStore.getState().showQuestionsSurface('conv-1')
    useSurfaceStore.getState().openTerminalTab('/tmp')

    useSurfaceStore.getState().closeTab(QUESTIONS_SURFACE_ID)
    expect(useSurfaceStore.getState().tabs.some((t) => t.id === QUESTIONS_SURFACE_ID)).toBe(true)

    const terminal = useSurfaceStore.getState().tabs.find((t) => t.kind === 'terminal')
    expect(terminal).toBeDefined()
    useSurfaceStore.getState().closeOthers(terminal!.id)
    expect(useSurfaceStore.getState().tabs.some((t) => t.id === QUESTIONS_SURFACE_ID)).toBe(true)
  })

  it('setVisible(false) is refused while the conversation has a live workflow', () => {
    useSurfaceStore.getState().showQuestionsSurface('conv-1')
    useSurfaceStore.getState().setVisible(false)
    expect(useSurfaceStore.getState().visible).toBe(true)

    useSurfaceStore.getState().retireQuestionsSurface('conv-1')
    useSurfaceStore.getState().setVisible(false)
    expect(useSurfaceStore.getState().visible).toBe(false)
  })

  it('retireQuestionsSurface restores the previously active tab when still valid', () => {
    // Focus was on plan before the workflow arrived.
    useSurfaceStore.getState().openSingleton('plan')
    expect(useSurfaceStore.getState().activeTabId).toBe('plan')

    useSurfaceStore.getState().showQuestionsSurface('conv-1')
    expect(useSurfaceStore.getState().activeTabId).toBe(QUESTIONS_SURFACE_ID)

    useSurfaceStore.getState().retireQuestionsSurface('conv-1')
    const s = useSurfaceStore.getState()
    expect(s.tabs.some((t) => t.id === QUESTIONS_SURFACE_ID)).toBe(false)
    expect(s.activeTabId).toBe('plan')
  })

  it('the questions tab never reaches persisted serialization', () => {
    useSurfaceStore.getState().showQuestionsSurface('conv-1')
    const s = useSurfaceStore.getState()
    const serialized = serializeSurface(s.pinnedTabs, s.notification, s.conversations)
    for (const conversation of Object.values(serialized.conversations)) {
      expect(conversation.tabs.some((t) => t.id === QUESTIONS_SURFACE_ID)).toBe(false)
    }
  })
})

describe('re-entering a conversation that owes an answer', () => {
  it('lands on the Questions tab with the pane open, overriding the saved focus', () => {
    // The defect: switching away and back restored "whatever was focused last
    // time", so a conversation waiting on the operator opened on Diff or
    // Explorer and looked idle. A parked question is the one surface the run
    // cannot continue without, so re-entry always defaults to it.
    const store = useSurfaceStore.getState()
    store.showQuestionsSurface('conv-1')
    // Operator deliberately moves to another tab while here.
    useSurfaceStore.getState().openSingleton('plan')
    expect(useSurfaceStore.getState().activeTabId).toBe('plan')

    // Leave and come back.
    useSurfaceStore.getState().selectConversation('conv-2')
    useSurfaceStore.getState().selectConversation('conv-1')

    const s = useSurfaceStore.getState()
    expect(s.activeTabId).toBe(QUESTIONS_SURFACE_ID)
    expect(s.visible).toBe(true)
  })

  it('does not force focus while the operator stays in the conversation', () => {
    // Re-entry default, not a lock: switching tabs must keep working.
    useSurfaceStore.getState().showQuestionsSurface('conv-1')
    useSurfaceStore.getState().openSingleton('plan')

    expect(useSurfaceStore.getState().activeTabId).toBe('plan')
  })

  it('leaves a conversation with no outstanding question alone', () => {
    // The guard against over-reach: only a conversation that actually owes an
    // answer gets its focus overridden.
    useSurfaceStore.getState().selectConversation('conv-2')
    useSurfaceStore.getState().openSingleton('plan')
    useSurfaceStore.getState().selectConversation('conv-1')
    useSurfaceStore.getState().selectConversation('conv-2')

    expect(useSurfaceStore.getState().activeTabId).toBe('plan')
  })
})
