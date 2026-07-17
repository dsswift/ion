// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentStateUpdate } from '../../../shared/types'
import type { DispatchTelemetryEntry } from '../../../shared/types-engine'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Mocks ──

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ unifiedTurnView: false, agentPanelDefaultOpen: false, agentDetailPopup: false }),
}))

const mockGetConversation = vi.fn()
;(globalThis as any).window = globalThis.window ?? {}
;(globalThis as any).window.ion = { getConversation: mockGetConversation }

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      agentDetailGeometry: { x: 60, y: 80, w: 600, h: 500 },
      setAgentDetailGeometry: vi.fn(),
      incOpenFloatingPanelCount: vi.fn(),
      decOpenFloatingPanelCount: vi.fn(),
      dispatchActivity: {},
    }),
}))

// Mock FloatingPanel as a passthrough
vi.mock('../FloatingPanel', () => ({
  FloatingPanel: ({ children, title }: any) =>
    React.createElement('div', { 'data-testid': 'floating-panel', 'data-title': title }, children),
}))

// Mock Transcript to render breadcrumb-detectable content. Capture the
// subDispatch prop so we can pin that AgentDetailPanel marks the embedded child
// panel as a sub-dispatch tier (bypassing the top-level visibility filter).
const transcriptProps: { subDispatch?: boolean } = {}
vi.mock('../conversation/Transcript', () => ({
  Transcript: ({ messages, pinnedPrompt, onOpenDispatch, agents, subDispatch }: any) => {
    transcriptProps.subDispatch = subDispatch
    return React.createElement('div', { 'data-testid': 'transcript' },
      pinnedPrompt && React.createElement('div', { 'data-testid': 'pinned-prompt' }, pinnedPrompt),
      React.createElement('div', null, `${messages?.length ?? 0} messages`),
      agents?.map((a: any, i: number) =>
        React.createElement('button', {
          key: i,
          'data-testid': `open-child-${a.name}`,
          onClick: () => {
            const dispatch = a.metadata?.dispatches?.[0]
            if (dispatch && onOpenDispatch) onOpenDispatch(dispatch, a)
          },
        }, a.name),
      ),
    )
  },
}))

vi.mock('../agent-conversation-mapper', () => ({
  mapConversationMessages: (msgs: any[]) => msgs.map((m: any, i: number) => ({
    id: `mapped-${i}`,
    role: m.role || 'assistant',
    content: m.content || '',
    timestamp: 0,
  })),
}))

import { AgentDetailPanel } from '../AgentDetailPanel'
import type { BreadcrumbFrame } from '../agent-panel-helpers'

function makeAgent(name: string): AgentStateUpdate {
  return { name, status: 'done', metadata: { displayName: name } }
}

function makeDispatch(id: string, conversationId: string, model = 'claude-sonnet-4-20250514', elapsed = 10) {
  return { id, task: 'test', model, conversationId, status: 'done', elapsed }
}

function entry(overrides: Partial<DispatchTelemetryEntry>): DispatchTelemetryEntry {
  return {
    dispatchAgent: 'agent',
    dispatchSessionId: 'ss',
    dispatchModel: 'claude-sonnet-4-20250514',
    dispatchTask: 'task',
    dispatchDepth: 0,
    dispatchParentId: '',
    dispatchId: 'did',
    ...overrides,
  }
}

function renderPanel(props: Parameters<typeof AgentDetailPanel>[0]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(React.createElement(AgentDetailPanel, props)) })
  return {
    container,
    // Re-render with fresh props to simulate an engine_agent_state heartbeat,
    // where the popup passes a new `agent` object (and new telemetry/allAgents
    // arrays) of the same identity every render.
    rerender(next: Parameters<typeof AgentDetailPanel>[0]) {
      act(() => { root.render(React.createElement(AgentDetailPanel, next)) })
    },
    unmount() {
      act(() => { root.unmount() })
      document.body.removeChild(container)
    },
  }
}

describe('AgentDetailPanel', () => {
  beforeEach(() => {
    mockGetConversation.mockReset()
    mockGetConversation.mockResolvedValue({
      messages: [
        { role: 'user', content: 'Do this task' },
        { role: 'assistant', content: 'Done' },
      ],
    })
  })

  it('renders breadcrumb with root agent name', () => {
    const { container, unmount } = renderPanel({
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Hello', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
    })
    expect(container.textContent).toContain('dev-lead')
    unmount()
  })

  it('renders model name in header metadata for a single-dispatch agent', () => {
    const { container, unmount } = renderPanel({
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Hello', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1', 'claude-opus-4-20250514', 42)],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
    })
    // DispatchMetaBar shows model and duration
    expect(container.textContent).toContain('claude-opus-4-20250514')
    expect(container.textContent).toContain('Duration:')
    // DispatchPager returns null for single dispatch — no "Dispatches:" label
    expect(container.textContent).not.toContain('Dispatches:')
    unmount()
  })

  it('renders DispatchPager pill strip for a multi-dispatch agent', () => {
    const dispatches = [
      makeDispatch('d1', 'conv-1', 'claude-opus-4-20250514', 20),
      makeDispatch('d2', 'conv-2', 'claude-sonnet-4-20250514', 15),
    ]
    const { container, unmount } = renderPanel({
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Hello', timestamp: 0 }],
      loading: false,
      dispatches,
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
    })
    // DispatchPager renders "Dispatches:" label and pills (#1, #2)
    expect(container.textContent).toContain('Dispatches:')
    expect(container.textContent).toContain('#1')
    expect(container.textContent).toContain('#2')
    // Metadata row still present
    expect(container.textContent).toContain('Model:')
    unmount()
  })

  it('header metadata and pager appear above the Transcript in DOM order', () => {
    const dispatches = [
      makeDispatch('d1', 'conv-1', 'test-model', 5),
      makeDispatch('d2', 'conv-2', 'test-model', 5),
    ]
    const { container, unmount } = renderPanel({
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Hello', timestamp: 0 }],
      loading: false,
      dispatches,
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
    })
    const transcript = container.querySelector('[data-testid="transcript"]')
    const text = container.textContent || ''
    const metaIdx = text.indexOf('Model:')
    const pagerIdx = text.indexOf('Dispatches:')
    const transcriptIdx = transcript ? text.indexOf(transcript.textContent || '') : -1

    // Both header rows appear before the transcript content
    expect(metaIdx).toBeGreaterThanOrEqual(0)
    expect(pagerIdx).toBeGreaterThanOrEqual(0)
    if (transcriptIdx >= 0) {
      expect(pagerIdx).toBeLessThan(transcriptIdx)
      expect(metaIdx).toBeLessThan(transcriptIdx)
    }
    unmount()
  })

  it('pushes a frame when onOpenDispatch fires and shows 2-deep breadcrumb', () => {
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'd1', dispatchParentId: '', dispatchAgent: 'dev-lead', conversationId: 'conv-1' }),
      entry({ dispatchId: 'd2', dispatchParentId: 'd1', dispatchAgent: 'worker-a', conversationId: 'conv-2' }),
    ]

    const { container, unmount } = renderPanel({
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Root msg', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: telemetry,
    })

    const childBtn = container.querySelector('[data-testid="open-child-worker-a"]') as HTMLButtonElement
    expect(childBtn).toBeTruthy()

    act(() => { childBtn.click() })

    // Both names should appear in the breadcrumb
    expect(container.textContent).toContain('dev-lead')
    expect(container.textContent).toContain('worker-a')
    unmount()
  })

  it('3-deep breadcrumb render and pop truncates', () => {
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'd1', dispatchParentId: '', dispatchAgent: 'root', conversationId: 'conv-1' }),
      entry({ dispatchId: 'd2', dispatchParentId: 'd1', dispatchAgent: 'mid', conversationId: 'conv-2' }),
      entry({ dispatchId: 'd3', dispatchParentId: 'd2', dispatchAgent: 'leaf', conversationId: 'conv-3' }),
    ]

    const { container, unmount } = renderPanel({
      agent: makeAgent('root'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Start', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: telemetry,
    })

    // Navigate to mid
    const midBtn = container.querySelector('[data-testid="open-child-mid"]') as HTMLButtonElement
    expect(midBtn).toBeTruthy()
    act(() => { midBtn.click() })

    expect(container.textContent).toContain('mid')

    // Navigate to leaf
    const leafBtn = container.querySelector('[data-testid="open-child-leaf"]') as HTMLButtonElement
    if (leafBtn) {
      act(() => { leafBtn.click() })
      expect(container.textContent).toContain('leaf')

      // All three names should be in the breadcrumb
      expect(container.textContent).toContain('root')
      expect(container.textContent).toContain('mid')
      expect(container.textContent).toContain('leaf')

      // Pop back to root by clicking the root crumb
      const crumbs = container.querySelectorAll('span[style*="cursor: pointer"]')
      // The root crumb is clickable (not last)
      const rootCrumb = Array.from(crumbs).find(el => el.textContent === 'root')
      if (rootCrumb) {
        act(() => { (rootCrumb as HTMLElement).click() })
        // After pop, only root should remain as the active (last) crumb
        // mid and leaf should NOT be in the breadcrumb anymore
        const text = container.textContent || ''
        expect(text).toContain('root')
        // leaf breadcrumb should be gone (only root frame remains)
        const breadcrumbSection = container.querySelector('[style*="flex-wrap"]')
        if (breadcrumbSection) {
          expect(breadcrumbSection.textContent).not.toContain('leaf')
          expect(breadcrumbSection.textContent).not.toContain('mid')
        }
      }
    }
    unmount()
  })

  it('fires getConversation with child conversationId on drill-in', async () => {
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'd1', dispatchParentId: '', dispatchAgent: 'parent', conversationId: 'conv-parent' }),
      entry({ dispatchId: 'd2', dispatchParentId: 'd1', dispatchAgent: 'child', conversationId: 'conv-child' }),
    ]

    const { container, unmount } = renderPanel({
      agent: makeAgent('parent'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Do task', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-parent')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: telemetry,
    })

    const childBtn = container.querySelector('[data-testid="open-child-child"]') as HTMLButtonElement
    act(() => { childBtn.click() })

    // Wait for the async loadConversation to fire
    await vi.waitFor(() => {
      expect(mockGetConversation).toHaveBeenCalledWith('conv-child', 0, 200)
    })

    unmount()
  })

  it('marks the embedded child panel as a sub-dispatch tier (subDispatch=true)', () => {
    // The embedded panel must bypass the top-level-only visibility filter so a
    // completed child with no `visibility` metadata still shows. AgentDetailPanel
    // signals that by passing subDispatch to Transcript.
    transcriptProps.subDispatch = undefined
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'd1', dispatchParentId: '', dispatchAgent: 'dev-lead', conversationId: 'conv-1' }),
      entry({ dispatchId: 'd2', dispatchParentId: 'd1', dispatchAgent: 'engine-dev', conversationId: 'conv-2' }),
    ]
    const { unmount } = renderPanel({
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Root msg', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: telemetry,
    })
    expect(transcriptProps.subDispatch).toBe(true)
    unmount()
  })

  // ── Durable-source regression: nested child renders from agent-state even
  //    when the one-shot dispatchTelemetry was never observed (late attach).

  // Build an agent-state pill carrying the same nesting attribution the engine
  // stamps (dispatchParentId + a dispatches[] entry). This survives
  // engine_agent_state heartbeat replay, unlike the dispatchTelemetry stream.
  function makeChildPill(
    name: string,
    parentDispatchId: string,
    dispatchId: string,
    conversationId: string,
    visibility?: string,
    status: AgentStateUpdate['status'] = 'done',
  ): AgentStateUpdate {
    return {
      name,
      status,
      metadata: {
        displayName: name,
        ...(visibility ? { visibility } : {}),
        dispatchParentId: parentDispatchId,
        dispatchDepth: 2,
        dispatches: [{ id: dispatchId, task: 't', model: 'm', conversationId, status, elapsed: 5 }],
      },
    }
  }

  it('renders nested child from agent-state when dispatchTelemetry is EMPTY (late-attach regression)', () => {
    // The exact failed scenario: the dev-lead's preview is opened on a dispatch
    // whose engine-dev child completed before the desktop saw the live
    // dispatch_start. dispatchTelemetry is empty; only the durable agent-state
    // pill survives (heartbeat-replayed). engine-dev must still render.
    const engineDevPill = makeChildPill('engine-dev', 'd1', 'd2', 'conv-2')

    const { container, unmount } = renderPanel({
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Root msg', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: [], // one-shot stream missed entirely
      allAgents: [makeAgent('dev-lead'), engineDevPill],
    })

    // engine-dev renders as a child row (the mocked Transcript emits one button
    // per agent in `agents`). Reverting to telemetry-only sourcing makes this
    // button absent -> red.
    const childBtn = container.querySelector('[data-testid="open-child-engine-dev"]')
    expect(childBtn).toBeTruthy()
    expect(container.textContent).toContain('engine-dev')
    unmount()
  })

  it('renders an ephemeral, done child (visibility is ignored for nested dispatches)', () => {
    // Nested dispatches must always show regardless of visibility metadata. A
    // done + ephemeral child would be filtered by the top-level visibility
    // rule, but the sub-dispatch panel bypasses it and sources from agent-state.
    const ephemeralChild = makeChildPill('engine-dev', 'd1', 'd2', 'conv-2', 'ephemeral', 'done')

    const { container, unmount } = renderPanel({
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Root msg', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: [],
      allAgents: [makeAgent('dev-lead'), ephemeralChild],
    })

    expect(container.querySelector('[data-testid="open-child-engine-dev"]')).toBeTruthy()
    unmount()
  })

  it('does not duplicate a child present in both agent-state and telemetry (union by dispatch id)', () => {
    // The live path can deliver both a dispatch_start (telemetry) and an
    // agent-state pill for the same child. The rendered set must contain ONE
    // engine-dev row (agent-state wins), not two.
    const engineDevPill = makeChildPill('engine-dev', 'd1', 'd2', 'conv-2')

    const { container, unmount } = renderPanel({
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Root msg', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: [entry({ dispatchId: 'd2', dispatchParentId: 'd1', dispatchAgent: 'engine-dev', conversationId: 'conv-2' })],
      allAgents: [makeAgent('dev-lead'), engineDevPill],
    })

    const childButtons = container.querySelectorAll('[data-testid="open-child-engine-dev"]')
    expect(childButtons.length).toBe(1)
    unmount()
  })

  it('keeps the drilled-in child across a heartbeat re-render (snap-back regression)', () => {
    // Repro of the "snaps back to parent" bug: after drilling from dev-lead into
    // its engine-dev child, an engine_agent_state heartbeat re-renders the popup
    // with a NEW `agent` object and NEW telemetry/allAgents arrays of the same
    // identity. The breadcrumb reset effect must NOT refire on that ref churn —
    // the drilled-in child must remain the active frame. Reverting the effect
    // deps (adding `agent` / `initialStack` back) resets the stack to root here
    // and this test goes red.
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'd1', dispatchParentId: '', dispatchAgent: 'dev-lead', conversationId: 'conv-1' }),
      entry({ dispatchId: 'd2', dispatchParentId: 'd1', dispatchAgent: 'engine-dev', conversationId: 'conv-2' }),
    ]

    const baseProps: Parameters<typeof AgentDetailPanel>[0] = {
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Root msg', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: telemetry,
    }

    const { container, rerender, unmount } = renderPanel(baseProps)

    // Drill into the engine-dev child.
    const childBtn = container.querySelector('[data-testid="open-child-engine-dev"]') as HTMLButtonElement
    expect(childBtn).toBeTruthy()
    act(() => { childBtn.click() })

    const breadcrumbBefore = container.querySelector('[style*="flex-wrap"]')
    expect(breadcrumbBefore?.textContent).toContain('engine-dev')

    // Simulate a heartbeat: fresh `agent` object + fresh telemetry array, same
    // identity (same name, same dispatch ids).
    rerender({
      ...baseProps,
      agent: makeAgent('dev-lead'),
      dispatchTelemetry: [
        entry({ dispatchId: 'd1', dispatchParentId: '', dispatchAgent: 'dev-lead', conversationId: 'conv-1' }),
        entry({ dispatchId: 'd2', dispatchParentId: 'd1', dispatchAgent: 'engine-dev', conversationId: 'conv-2' }),
      ],
    })

    // The breadcrumb must still show engine-dev as the drilled-in frame.
    const breadcrumbAfter = container.querySelector('[style*="flex-wrap"]')
    expect(breadcrumbAfter?.textContent).toContain('engine-dev')
    unmount()
  })

  it('re-adopts a NEW deep-link target stack across a heartbeat (initialStack target change still resets)', () => {
    // The fix keys the reset on the deep-link TARGET dispatch id, not the array
    // ref. A genuinely different deep-link target must still re-seed the stack,
    // while a rebuilt-but-identical initialStack (heartbeat) must not clobber it.
    const stackA: BreadcrumbFrame[] = [
      { dispatchId: 'd1', conversationId: 'conv-1', agentDisplayName: 'dev-lead' },
      { dispatchId: 'd2', conversationId: 'conv-2', agentDisplayName: 'engine-dev' },
    ]
    const stackB: BreadcrumbFrame[] = [
      { dispatchId: 'd1', conversationId: 'conv-1', agentDisplayName: 'dev-lead' },
      { dispatchId: 'd3', conversationId: 'conv-3', agentDisplayName: 'security-officer' },
    ]

    const baseProps: Parameters<typeof AgentDetailPanel>[0] = {
      agent: makeAgent('dev-lead'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'Root msg', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      initialStack: stackA,
    }

    const { container, rerender, unmount } = renderPanel(baseProps)
    expect(container.querySelector('[style*="flex-wrap"]')?.textContent).toContain('engine-dev')

    // Heartbeat with a rebuilt-but-identical stack (new array, same target): no
    // clobber — engine-dev stays.
    rerender({ ...baseProps, agent: makeAgent('dev-lead'), initialStack: [...stackA] })
    expect(container.querySelector('[style*="flex-wrap"]')?.textContent).toContain('engine-dev')

    // New deep-link target (different last dispatchId): re-seed to the new stack.
    rerender({ ...baseProps, agent: makeAgent('dev-lead'), initialStack: stackB })
    const breadcrumb = container.querySelector('[style*="flex-wrap"]')
    expect(breadcrumb?.textContent).toContain('security-officer')
    expect(breadcrumb?.textContent).not.toContain('engine-dev')
    unmount()
  })
})
