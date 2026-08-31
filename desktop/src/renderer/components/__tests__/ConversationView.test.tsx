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
const agentPanelProps: Array<Record<string, unknown>> = []
vi.mock('../AgentPanel', () => ({
  AgentPanel: (props: Record<string, unknown>) => {
    agentPanelProps.push(props)
    return null
  },
}))
vi.mock('../PermissionDeniedCard', () => ({ PermissionDeniedCard: () => null }))
vi.mock('../ElicitationCardHost', () => ({ ElicitationCardHost: () => null }))
vi.mock('../TodoListPanel', () => ({ TodoListPanel: () => null }))
vi.mock('../ConversationSearch', () => ({ ConversationSearch: () => null }))
vi.mock('../hooks/useConversationSearch', () => ({ useConversationSearch: () => [{}, {}] }))
vi.mock('../hooks/useClearPermissionDenied', () => ({ useClearPermissionDenied: () => vi.fn() }))
// One STABLE object, not a fresh literal per call: the real hook returns
// stable refs, and a new `scrollRef` identity on every render would re-run
// every effect that depends on it (the chart-jump subscription among them).
const scrollFollow = vi.hoisted(() => ({
  scrollRef: { current: null as HTMLElement | null }, contentRef: { current: null },
  isNearBottomRef: { current: true }, showScrollBtn: false,
  handleScroll: vi.fn(), handleWheel: vi.fn(), handleTouchStart: vi.fn(), handleTouchMove: vi.fn(),
  handlePointerMove: vi.fn(), handleKeyDown: vi.fn(), pauseFollowing: vi.fn(),
  // The chart jump takes the viewport through this, not pauseFollowing.
  beginNavigation: vi.fn(),
  scrollToBottom: vi.fn(),
}))
vi.mock('../conversation/useScrollFollow', () => ({
  useScrollFollow: () => scrollFollow,
}))
vi.mock('../conversation/TimelineMinimap', () => ({ TimelineMinimap: () => null }))
vi.mock('../conversation/TimelineMinimap.logic', () => ({ deriveTimelineMinimapItems: () => [] }))
// One derived timeline whose anchor deliberately differs from any gate id.
vi.mock('../conversation/chart-revisions', () => ({
  deriveChartTimelines: () => ([{
    chartId: 'chart-derived',
    title: 'Derived',
    currentMessageId: 'toolu_derived_row',
    revisions: [{ messageId: 'toolu_derived_row', spec: {}, revision: 1 }],
  }]),
}))

// Captures what the transcript is asked to jump to. Installed by the mocked
// TranscriptRows through the same ref the real component populates.
const virtualJump = vi.hoisted(() => ({ fn: null as ((id: string) => boolean) | null }))
vi.mock('../conversation/TranscriptRows', () => ({
  TranscriptRows: ({ virtualMessageJumpRef }: {
    virtualMessageJumpRef?: { current: ((id: string) => boolean) | null }
  }) => {
    if (virtualMessageJumpRef) {
      virtualMessageJumpRef.current = (id: string) => virtualJump.fn?.(id) ?? false
    }
    return <div>Transcript rows</div>
  },
}))
vi.mock('../conversation/ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }))
vi.mock('../conversation', () => ({
  groupMessages: () => [], suppressUserImageEchoes: (messages: unknown[]) => messages,
  MessageActions: () => null, QueuedMessage: () => null,
  EmptyState: () => <div>Empty conversation</div>, RunDurationFooter: () => null,
  InterruptButton: () => <button data-testid="interrupt-button">Interrupt</button>,
}))

import { ConversationView } from '../ConversationView'

// ConversationView subscribes to chart-jump requests at mount. The preload
// bridge is absent in jsdom, so the stub both keeps the mount working and
// captures the handler, which is what the chart-jump tests below drive.
const chartJumpHandlers: Array<(req: { tabId: string; chartId: string; messageId: string }) => void> = []
const unsubscribeChartJump = vi.fn()
;(window as unknown as { ion: Record<string, unknown> }).ion = {
  onChartJump: (cb: (req: { tabId: string; chartId: string; messageId: string }) => void) => {
    chartJumpHandlers.push(cb)
    return unsubscribeChartJump
  },
}

function setConversation(
  status: string,
  runningChildren: number,
  messages: Array<Record<string, unknown>> = [],
): void {
  const tabId = 'tab-1'
  state.tabs = [{ id: tabId, status, queuedPrompts: [], lastResult: null }]
  const statusFields = runningChildren < 0 ? {
    activeBackgroundTasks: [{ taskId: 'task-1', command: 'sleep 30', startedAt: 1 }],
  } : undefined
  const childCount = Math.max(0, runningChildren)
  state.conversationPanes = new Map([[tabId, {
    activeInstanceId: 'instance-1',
    instances: [{ id: 'instance-1', messages, statusFields, agentStates: Array.from(
      { length: childCount }, (_, index) => ({ name: `agent-${index}`, status: 'running' }),
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
  beforeEach(() => {
    vi.clearAllMocks()
    state.engineWorkingMessages = new Map()
    setConversation('idle', 0)
  })
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

  it('shows active background shells beside running activity', () => {
    setConversation('running', -1)
    const { container, root } = renderConversation()

    expect(container.querySelector('[data-testid="conversation-activity-indicator"]')?.textContent)
      .toContain('Running… · 1 background shell')
    act(() => { root.unmount() })
  })

  it('keeps Stop visible while only a background shell runs', () => {
    setConversation('waiting', -1)
    const { container, root } = renderConversation()
    expect(container.querySelector('[data-testid="conversation-activity-row"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="conversation-interrupt-row"]')).toBeTruthy()
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

// Regression pin for the reported bug: ConversationView must pass its own
// tabId to AgentPanel. Without it, AgentRow's row-level Stop control is gated
// off entirely (AgentRow.tsx guards on `tabId && stoppableDispatchId`), so
// every running Agent row in the main conversation loses its Stop button.
// Reverting the tabId prop on <AgentPanel> in ConversationView.tsx turns this
// red.
describe('ConversationView agent panel wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentPanelProps.length = 0
    state.engineWorkingMessages = new Map()
    setConversation('idle', 0)
  })
  afterEach(() => { document.body.replaceChildren() })

  it('forwards its own tabId to AgentPanel', () => {
    const { root } = renderConversation()
    expect(agentPanelProps.at(-1)?.tabId).toBe('tab-1')
    act(() => { root.unmount() })
  })
})

/**
 * Chart-jump routing.
 *
 * A jump is broadcast to every conversation, because main knows the target tab
 * but not which renderer owns it. Each transcript must therefore ignore a
 * request addressed to a different tab — otherwise every open conversation
 * would scroll at once when a chart row is clicked in one of them.
 */
describe('ConversationView chart jump', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chartJumpHandlers.length = 0
    scrollFollow.scrollRef.current = null
    setConversation('idle', 0)
  })
  afterEach(() => { document.body.replaceChildren() })

  it('subscribes on mount and unsubscribes on unmount', () => {
    const { root } = renderConversation()
    expect(chartJumpHandlers).toHaveLength(1)
    act(() => { root.unmount() })
    expect(unsubscribeChartJump).toHaveBeenCalled()
  })

  it('scrolls to the chart anchor when the request names this tab', () => {
    const { container, root } = renderConversation()
    scrollFollow.scrollRef.current = container
    const anchor = document.createElement('div')
    anchor.setAttribute('data-chart-id', 'chart-1')
    const scrollIntoView = vi.fn()
    anchor.scrollIntoView = scrollIntoView
    container.appendChild(anchor)

    act(() => {
      chartJumpHandlers[0]({ tabId: 'tab-1', chartId: 'chart-1', messageId: 'msg-1' })
    })
    // 'start', not 'center': the virtual path anchors the card near the top
    // of the viewport, and both presentations must land the same way.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    act(() => { root.unmount() })
  })

  it('prefers the derived anchor over the id the resource carries', () => {
    // A chart record stores the tool-GATE id it was minted from, while a
    // transcript row is keyed by the engine's tool-USE id. Jumping on the
    // stored value found no row, so the transcript never moved. The virtual
    // jump must therefore be asked for the DERIVED anchor.
    const { root } = renderConversation()
    const attempted: string[] = []
    virtualJump.fn = (id: string) => { attempted.push(id); return true }

    act(() => {
      chartJumpHandlers[0]({
        tabId: 'tab-1',
        chartId: 'chart-derived',
        messageId: 'tool-gate-999-1',
      })
    })

    // With a timeline present, the stored gate id must NOT be what is tried.
    expect(attempted).toEqual(['toolu_derived_row'])
    act(() => { root.unmount() })
  })

  it('falls back to the carried id when no timeline is derived', () => {
    // A chart the current branch cannot see has no derived anchor; the stored
    // id is then the only thing to try, rather than giving up silently.
    const { root } = renderConversation()
    const attempted: string[] = []
    virtualJump.fn = (id: string) => { attempted.push(id); return true }

    act(() => {
      chartJumpHandlers[0]({ tabId: 'tab-1', chartId: 'unknown-chart', messageId: 'tool-gate-777-1' })
    })

    expect(attempted).toEqual(['tool-gate-777-1'])
    act(() => { root.unmount() })
  })

  it('ignores a request addressed to another tab', () => {
    const { container, root } = renderConversation()
    scrollFollow.scrollRef.current = container
    const anchor = document.createElement('div')
    anchor.setAttribute('data-chart-id', 'chart-1')
    const scrollIntoView = vi.fn()
    anchor.scrollIntoView = scrollIntoView
    container.appendChild(anchor)

    act(() => {
      chartJumpHandlers[0]({ tabId: 'tab-OTHER', chartId: 'chart-1', messageId: 'msg-1' })
    })
    expect(scrollIntoView).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })
})
