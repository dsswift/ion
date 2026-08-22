// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state: Record<string, any> = {
  conversationPanes: new Map(), tabs: [], enginePinnedPrompt: new Map(),
  engineNotifications: new Map(), engineWorkingMessages: new Map(), staticInfo: null,
  tabsReady: false, submit: vi.fn(), interrupt: vi.fn(), editQueuedMessage: vi.fn(),
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (snapshot: typeof state) => unknown) => selector(state),
    { getState: () => state, setState: vi.fn() },
  ),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (snapshot: Record<string, unknown>) => unknown) =>
    selector({ dataViewFontSize: 14, unifiedTurnView: false }),
}))
vi.mock('../../theme', () => ({
  useColors: () => ({
    textTertiary: '#888888', accent: '#3366ff', containerBg: '#101013', statusRunning: '#d97757',
    statusWaitingChildren: '#cc9900',
  }),
}))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rError: vi.fn() }))
vi.mock('zustand/shallow', () => ({ useShallow: (selector: unknown) => selector }))
vi.mock('../EngineDialog', () => ({ EngineDialog: () => null }))
vi.mock('../EngineNotificationToasts', () => ({ EngineNotificationToasts: () => null }))
vi.mock('../AgentPanel', () => ({ AgentPanel: () => null }))
vi.mock('../PermissionDeniedCard', () => ({ PermissionDeniedCard: () => null }))
vi.mock('../ElicitationCardHost', () => ({ ElicitationCardHost: () => null }))
vi.mock('../TodoListPanel', () => ({ TodoListPanel: () => null }))
vi.mock('../ConversationSearch', () => ({ ConversationSearch: () => null }))
vi.mock('../hooks/useConversationSearch', () => ({ useConversationSearch: () => [{}, {}] }))
vi.mock('../hooks/useClearPermissionDenied', () => ({ useClearPermissionDenied: () => vi.fn() }))
vi.mock('../conversation/useScrollFollow', () => ({
  useScrollFollow: () => ({ scrollRef: { current: null }, contentRef: { current: null }, isNearBottomRef: { current: true }, showScrollBtn: false, handleScroll: vi.fn(), scrollToBottom: vi.fn() }),
}))
vi.mock('../conversation/TimelineMinimap', () => ({ TimelineMinimap: () => null }))
vi.mock('../conversation/TimelineMinimap.logic', () => ({ deriveTimelineMinimapItems: () => [] }))
vi.mock('../conversation/TranscriptRows', () => ({ TranscriptRows: () => <div>Transcript rows</div> }))
vi.mock('../conversation/ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }))
vi.mock('../conversation', () => ({
  groupMessages: () => [], suppressUserImageEchoes: (messages: unknown[]) => messages,
  MessageActions: () => null, QueuedMessage: () => null,
  EmptyState: () => <div>Empty conversation</div>, RunDurationFooter: () => null,
  InterruptButton: () => <button data-testid="interrupt-button">Interrupt</button>,
}))

import { ConversationView } from '../ConversationView'

function setConversation(
  status: string,
  runningChildren: number,
  messages: Array<Record<string, unknown>> = [],
): void {
  const tabId = 'tab-1'
  state.tabs = [{ id: tabId, status, queuedPrompts: [], lastResult: null }]
  state.conversationPanes = new Map([[tabId, {
    activeInstanceId: 'instance-1',
    instances: [{ id: 'instance-1', messages, agentStates: Array.from(
      { length: runningChildren }, (_, index) => ({ name: `agent-${index}`, status: 'running' }),
    ), dispatchTelemetry: [] }],
  }]])
}

function renderConversation(): { container: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(<ConversationView tabId="tab-1" />) })
  return { container, root }
}

describe('ConversationView composer activity row', () => {
  beforeEach(() => { vi.clearAllMocks(); setConversation('idle', 0) })
  afterEach(() => { document.body.replaceChildren() })

  it('uses a gradient blur overlay, not a divider panel', () => {
    setConversation('running', 0)
    const { container, root } = renderConversation()
    const activityRow = container.querySelector('[data-testid="conversation-activity-row"]') as HTMLElement
    const interruptRow = container.querySelector('[data-testid="conversation-interrupt-row"]') as HTMLElement
    const activity = container.querySelector('[data-testid="conversation-activity-indicator"]')
    const transcript = container.querySelector('[data-testid="conversation-transcript"]') as HTMLElement | null

    // The blur/gradient live on a static child layer, not the row itself —
    // an animating child (the pulse dot) inside a backdrop-filter element
    // forces that element to re-sample every frame it ticks, so the blur
    // layer must not contain the animation.
    const blurLayer = activityRow.firstElementChild as HTMLElement

    expect(activityRow.textContent).toContain('Running…')
    expect(activityRow.style.position).toBe('absolute')
    expect(activityRow.style.bottom).toBe('0px')
    expect(blurLayer.style.background).toContain('linear-gradient')
    expect(blurLayer.style.backdropFilter).toBe('blur(5px)')
    expect(activityRow.style.borderTop).toBe('')
    expect(transcript?.style.paddingBottom).toBe('64px')
    expect(interruptRow.querySelector('[data-testid="interrupt-button"]')).toBeTruthy()
    expect(transcript?.textContent).not.toContain('Running…')
    expect(activity).toBeTruthy()
    act(() => { root.unmount() })
  })

  it('uses active thinking over generic running activity', () => {
    setConversation('running', 0, [{ role: 'thinking', thinkingActive: true }])
    const { container, root } = renderConversation()

    expect(container.querySelector('[data-testid="conversation-activity-indicator"]')?.textContent)
      .toContain('Thinking…')
    act(() => { root.unmount() })
  })

  it('uses the engine working message over generic running activity', () => {
    setConversation('running', 0)
    state.engineWorkingMessages.set('tab-1', 'Compacting…')
    const { container, root } = renderConversation()

    expect(container.querySelector('[data-testid="conversation-activity-indicator"]')?.textContent)
      .toContain('Compacting…')
    act(() => { root.unmount() })
  })

  it('keeps interrupt but hides orchestrator activity while only children run', () => {
    setConversation('idle', 1)
    const { container, root } = renderConversation()

    const interruptRow = container.querySelector('[data-testid="conversation-interrupt-row"]')
    expect(interruptRow?.querySelector('[data-testid="interrupt-button"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="conversation-activity-indicator"]')).toBeNull()
    const transcript = container.querySelector('[data-testid="conversation-transcript"]') as HTMLElement | null
    expect(transcript?.style.paddingBottom).toBe('64px')
    expect(interruptRow?.textContent).not.toContain('Waiting for agent')
    act(() => { root.unmount() })
  })
})
