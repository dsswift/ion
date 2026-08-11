// @vitest-environment jsdom
//
// Slow-reconcile backstop test for the live-dispatch transcript. The real-time
// transcript is carried by the dispatch_activity push path (see
// agent-dispatch-activity.test.ts); the AgentPanel popup additionally runs a
// SLOW (~12s) reconcile timer that re-fetches the file-backed snapshot to heal
// any gap from a dropped delta or reconnect, plus a final reconcile on terminal.
//
// This pins that (a) the fast 1.5s poll is gone — advancing 2s does NOT refetch
// — and (b) the 12s reconcile DOES refetch and the grown snapshot reaches the
// open popup. Reverting the reconcile effect turns this red.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// --- Mock the heavy dependency modules so the test isolates AgentPanel's
//     polling logic from theme, store, and child-render concerns. ---

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../../preferences', () => ({
  // Popup mode ON so clicking an agent opens the floating detail panel (the
  // surface the poller drives). default-open so the panel is expanded.
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ agentPanelDefaultOpen: true, unifiedTurnView: false }),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      agentDetailGeometry: { x: 60, y: 80, w: 600, h: 500 },
      setAgentDetailGeometry: () => {},
      // Live push transcript map — empty here; this test exercises the slow
      // file-backed reconcile path, not the push fold (covered by
      // agent-dispatch-activity.test.ts).
      dispatchActivity: {},
    }),
}))

// FloatingPanel renders its children directly so the detail popup mounts in the
// test DOM without portal/measurement machinery.
vi.mock('../FloatingPanel', () => ({
  FloatingPanel: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'floating-panel' }, children),
}))

// The conversation barrel pulls in markdown/codemirror-heavy components. Stub
// the pieces the detail panel consumes with simple text renderers so the
// transcript content is assertable.
vi.mock('../conversation', () => ({
  groupMessages: (msgs: Array<{ id: string; content: string }>) =>
    msgs.map((m) => ({ kind: 'user' as const, message: m })),
  ToolGroup: () => null,
  AssistantMessage: () => null,
  MessageBubble: ({ message }: { message: { content: string } }) =>
    React.createElement('div', null, message.content),
  AgentTurnGroup: () => null,
  ThinkingBlock: () => null,
}))

// The popup path renders messages through the real Transcript, which uses
// TranscriptRows + tool-helpers.groupMessages (NOT the barrel above). Stub those
// so the popup transcript content is assertable as plain text.
vi.mock('../conversation/tool-helpers', () => ({
  groupMessages: (msgs: Array<{ id: string; content: string }>) =>
    msgs.map((m) => ({ kind: 'user' as const, message: m })),
}))
vi.mock('../conversation/TranscriptRows', () => ({
  TranscriptRows: ({ grouped }: { grouped: Array<{ message: { content: string } }> }) =>
    React.createElement(
      'div',
      null,
      grouped.map((g, i) => React.createElement('div', { key: i }, g.message?.content ?? '')),
    ),
}))

import { AgentPanel } from '../AgentPanel'
import type { AgentStateUpdate } from '../../../shared/types'

const RUNNING_CONV = 'live-conv-id'

/** A running dispatched agent whose dispatch entry already carries a
 *  conversationId (the engine now surfaces it at dispatch start). */
function runningAgent(): AgentStateUpdate {
  return {
    name: 'dev-lead',
    id: 'dispatch-dev-lead-1',
    status: 'running',
    metadata: {
      displayName: 'Dev Lead',
      type: 'agent',
      visibility: 'sticky',
      invited: true,
      task: 'do multi-step work',
      dispatches: [
        {
          id: 'dispatch-dev-lead-1',
          task: 'do multi-step work',
          model: 'claude',
          status: 'running',
          conversationId: RUNNING_CONV,
          startTime: 1,
        },
      ],
    },
  } as unknown as AgentStateUpdate
}

describe('AgentPanel slow reconcile backstop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not fast-poll but reconciles on the slow cadence, surfacing grown snapshot', async () => {
    // getConversation returns a GROWING transcript across calls: one message on
    // the first fetch, two on subsequent fetches.
    let calls = 0
    const getConversation = vi.fn(async () => {
      calls++
      const messages =
        calls <= 1
          ? [{ role: 'assistant', content: 'first step', timestamp: 0 }]
          : [
              { role: 'assistant', content: 'first step', timestamp: 0 },
              { role: 'assistant', content: 'second step now visible', timestamp: 0 },
            ]
      return { messages, total: messages.length }
    })
    ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = { getConversation }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(React.createElement(AgentPanel, { agents: [runningAgent()] }))
    })
    // Let the default-open effect run so agent rows render.
    await act(async () => {
      await Promise.resolve()
    })

    // If the panel is still collapsed, click the header to expand it.
    if (!container.textContent?.includes('Dev Lead')) {
      const header = Array.from(container.querySelectorAll('div')).find((el) =>
        el.textContent?.includes('Agents ('),
      ) as HTMLElement | undefined
      if (header) {
        await act(async () => {
          header.click()
        })
      }
    }

    // Open the detail popup by clicking the agent's name label. Clicking the
    // inner span bubbles to the row's onClick (jsdom does not always fire the
    // handler when the outer flex row div is clicked directly).
    const label = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === 'Dev Lead',
    ) as HTMLElement | undefined
    expect(label, 'agent name label should be present').toBeTruthy()
    await act(async () => {
      label!.click()
    })

    // Flush the open-time one-shot load microtasks.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const callsAfterOpen = getConversation.mock.calls.length

    // Advancing well under the 12s reconcile interval must NOT trigger a
    // refetch — the fast 1.5s poll is gone; liveness is carried by the push
    // path, and this timer is only the slow correctness backstop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(getConversation.mock.calls.length).toBe(callsAfterOpen)

    // Advancing past the 12s reconcile cadence triggers the backstop refetch,
    // which replaces the cached transcript with the grown file-backed snapshot.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12500)
    })
    expect(getConversation.mock.calls.length).toBeGreaterThan(callsAfterOpen)

    // The later transcript message is now rendered in the open popup.
    expect(container.textContent).toContain('second step now visible')

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  // Regression: the 12s background reconcile must NOT flash the popup to the
  // "Loading conversation..." placeholder. Before the fix, refetchConversation
  // raised the loading flag on every poll cycle, so while each in-flight fetch
  // was pending the panel blanked its cached transcript for the placeholder —
  // the ~12s flashing the user saw. The reconcile now refetches silently.
  it('does not flash the loading placeholder on background reconcile', async () => {
    // The reconcile fetch is held PENDING via a deferred so the in-flight
    // window (where the old code showed the placeholder) is observable.
    let resolveReconcile: ((v: { messages: unknown[]; total: number }) => void) | null = null
    let calls = 0
    const getConversation = vi.fn(() => {
      calls++
      if (calls <= 1) {
        return Promise.resolve({
          messages: [{ role: 'assistant', content: 'first step', timestamp: 0 }],
          total: 1,
        })
      }
      return new Promise<{ messages: unknown[]; total: number }>((res) => {
        resolveReconcile = res
      })
    })
    ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = { getConversation }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(React.createElement(AgentPanel, { agents: [runningAgent()] }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    const label = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === 'Dev Lead',
    ) as HTMLElement | undefined
    expect(label, 'agent name label should be present').toBeTruthy()
    await act(async () => {
      label!.click()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // Initial one-shot load populated the popup.
    expect(container.textContent).toContain('first step')

    // Fire the 12s reconcile. Its fetch stays pending (deferred not resolved).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12500)
    })
    expect(getConversation.mock.calls.length).toBeGreaterThan(1)

    // While the reconcile fetch is in flight the cached transcript must remain
    // and the placeholder must NOT appear. Old code turned this red here.
    expect(container.textContent).toContain('first step')
    expect(container.textContent).not.toContain('Loading conversation')

    // Resolving the reconcile folds the grown snapshot into the open popup.
    await act(async () => {
      resolveReconcile?.({
        messages: [
          { role: 'assistant', content: 'first step', timestamp: 0 },
          { role: 'assistant', content: 'second step now visible', timestamp: 0 },
        ],
        total: 2,
      })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('second step now visible')
    expect(container.textContent).not.toContain('Loading conversation')

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
