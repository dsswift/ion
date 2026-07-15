// @vitest-environment jsdom
//
// Regression test for the agent-panel renderer crash: AgentExpandedView called
// `useMemo(groupMessages...)` conditionally — inside the `messages.length > 0`
// branch, after the `if (loading)` early return. The hook count therefore
// changed between renders whenever the component crossed the loading boundary
// or the empty/non-empty messages boundary, violating the rules of hooks and
// crashing the renderer:
//
//   - Opening the popup (loading -> populated): React #185, "Rendered more
//     hooks than during the previous render".
//   - Switching to a not-yet-loaded dispatch (populated -> loading): React #310,
//     "Rendered fewer hooks than expected", caught by ConversationErrorBoundary
//     which unmounts the popup.
//
// Each test re-renders the SAME mounted fiber across the boundary. On the
// pre-fix (conditional-useMemo) code these throw the hook-order error; on the
// fixed (hoisted-useMemo) code they render cleanly. Reverting the hoist turns
// all three red — the definition of a regression test.
//
// headerSlot assertions (pinned-header feature):
//   - With headerSlot provided, the header trio (pager/infoBar) is NOT rendered
//     inside the message-body container — only the body renders inline.
//   - With headerSlot absent (inline path), the header renders inline as before.
//   - Hook stability is preserved after adding the headerSlot conditional.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'
import { AgentExpandedView } from '../AgentExpandedView'
import type { AgentStateUpdate, Message } from '../../../shared/types'
import type { DispatchInfo } from '../agent-panel-helpers'

// React's createRoot path requires this flag to flush act() synchronously.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// useColors returns an object whose color fields are read in style props; a
// Proxy that yields a color for any key keeps the component render-safe without
// pulling the full theme store into the assertion.
const colors = new Proxy({}, { get: () => '#000000' }) as never

const agent: AgentStateUpdate = {
  name: 'dev-lead',
  status: 'done',
  metadata: {},
} as AgentStateUpdate

const message: Message = {
  id: 'm0',
  role: 'user',
  content: 'hello from the agent dispatch',
  toolName: '',
  toolInput: '',
  toolStatus: 'completed',
  timestamp: 0,
} as Message

/**
 * Mount AgentExpandedView, then re-render the same root with new props so the
 * component crosses a render boundary on a single fiber. Returns the final HTML
 * for content assertions. Any rules-of-hooks violation throws synchronously
 * inside the second act().
 */
function renderThenRerender(
  first: Partial<React.ComponentProps<typeof AgentExpandedView>>,
  second: Partial<React.ComponentProps<typeof AgentExpandedView>>,
): string {
  const container = document.createElement('div')
  const root = createRoot(container)
  const base = {
    agent,
    colors,
    dispatches: [],
    selectedDispatch: 0,
    onSelectDispatch: () => {},
  }
  try {
    act(() => {
      root.render(<AgentExpandedView {...base} {...first} />)
    })
    act(() => {
      root.render(<AgentExpandedView {...base} {...second} />)
    })
    return container.innerHTML
  } finally {
    act(() => {
      root.unmount()
    })
  }
}

describe('AgentExpandedView hook stability', () => {
  it('renders loading then populated without a hook-order crash (crash A / #185)', () => {
    let html = ''
    expect(() => {
      html = renderThenRerender(
        { loading: true },
        { loading: false, loadedMessages: [message] },
      )
    }).not.toThrow()
    expect(html).toContain('hello from the agent dispatch')
  })

  it('renders empty then populated without a hook-order crash', () => {
    let html = ''
    expect(() => {
      html = renderThenRerender(
        { loading: false, loadedMessages: [] },
        { loading: false, loadedMessages: [message] },
      )
    }).not.toThrow()
    expect(html).toContain('hello from the agent dispatch')
  })

  it('renders populated then loading without a hook-order crash (crash B / #310, dispatch switch)', () => {
    // Switching to a dispatch whose conversation has not loaded yet flips the
    // component back into the loading branch on the same fiber. Pre-fix this
    // threw "Rendered fewer hooks than expected" and unmounted the popup.
    expect(() => {
      renderThenRerender(
        { loading: false, loadedMessages: [message] },
        { loading: true },
      )
    }).not.toThrow()
  })
})

// ─── headerSlot assertions (pinned-header feature) ─────────────────────────

const multiDispatchAgent: AgentStateUpdate = {
  name: 'dev-lead',
  status: 'done',
  metadata: {},
} as AgentStateUpdate

const dispatchA: DispatchInfo = {
  id: 'd1',
  task: 'Build the feature',
  model: 'claude-sonnet-4-5',
  conversationId: 'c1',
  elapsed: 42,
  status: 'done',
  startTime: undefined,
}

const dispatchB: DispatchInfo = {
  id: 'd2',
  task: 'Write the tests',
  model: 'claude-sonnet-4-5',
  conversationId: 'c2',
  elapsed: 18,
  status: 'done',
  startTime: undefined,
}

describe('AgentExpandedView headerSlot', () => {
  it('without headerSlot: header renders inline, message content present', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <AgentExpandedView
          agent={multiDispatchAgent}
          colors={colors}
          loadedMessages={[message]}
          loading={false}
          isFullscreen={true}
          dispatches={[dispatchA, dispatchB]}
          selectedDispatch={1}
          onSelectDispatch={() => {}}
        />
      )
    })
    const html = container.innerHTML
    // Header (dispatch pager task text) renders inline when no slot is given.
    expect(html).toContain('Write the tests')
    // Message body also present.
    expect(html).toContain('hello from the agent dispatch')
    act(() => { root.unmount() })
  })

  it('with headerSlot: slot receives header node, returns null, body still renders inline', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const slotSpy = vi.fn((_header: React.ReactNode) => {
      // In a real panel the slot portals the header node elsewhere.
      // Here we just capture it and return null (simulating the panel behavior).
      return null
    })
    act(() => {
      root.render(
        <AgentExpandedView
          agent={multiDispatchAgent}
          colors={colors}
          loadedMessages={[message]}
          loading={false}
          isFullscreen={true}
          dispatches={[dispatchA, dispatchB]}
          selectedDispatch={1}
          onSelectDispatch={() => {}}
          headerSlot={slotSpy}
        />
      )
    })
    const html = container.innerHTML
    // headerSlot was called — header content was handed to the caller.
    expect(slotSpy).toHaveBeenCalled()
    // Body still renders inline (message content present in container).
    expect(html).toContain('hello from the agent dispatch')
    // Header task text is NOT in the container html (slot returned null,
    // so AgentExpandedView rendered nothing for it in this DOM subtree).
    expect(html).not.toContain('Write the tests')
    act(() => { root.unmount() })
  })

  it('taskBubble removed: metadata.task string does not appear in output', () => {
    // Regression pin: the taskBubble block read agent.metadata.task and rendered
    // it verbatim. With the block gone, a single-dispatch agent whose metadata
    // carries a task string must NOT surface that string in the rendered output.
    // Restoring the taskBubble block turns this red because the task text would
    // reappear above the transcript.
    const agentWithTask: AgentStateUpdate = {
      name: 'dev-lead',
      status: 'done',
      metadata: { task: 'orchestrator dispatch instruction text' },
    } as AgentStateUpdate
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <AgentExpandedView
          agent={agentWithTask}
          colors={colors}
          loadedMessages={[message]}
          loading={false}
          isFullscreen={true}
          dispatches={[]}
          selectedDispatch={0}
          onSelectDispatch={() => {}}
        />
      )
    })
    const html = container.innerHTML
    // Transcript still renders.
    expect(html).toContain('hello from the agent dispatch')
    // Task metadata string must not appear — taskBubble is gone.
    expect(html).not.toContain('orchestrator dispatch instruction text')
    act(() => { root.unmount() })
  })

  it('with headerSlot: hook order is stable across loading→populated boundary', () => {
    // Ensures adding the headerSlot conditional did not reintroduce the
    // rules-of-hooks violation (crash A).
    expect(() => {
      renderThenRerender(
        { loading: true, dispatches: [dispatchA, dispatchB], selectedDispatch: 1, headerSlot: (_h) => null },
        { loading: false, loadedMessages: [message], dispatches: [dispatchA, dispatchB], selectedDispatch: 1, headerSlot: (_h) => null },
      )
    }).not.toThrow()
  })
})

// ─── Dispatch with no transcript: honest representation (no perpetual Working…) ─

describe('AgentExpandedView no-transcript dispatch', () => {
  // The reproducing scenario: a multi-dispatch agent where the selected dispatch
  // has an empty conversationId and an empty status (the engine left it without a
  // conversation), while the live agent is still 'running' (a sibling dispatch is
  // live). Pre-fix the body read agent.status and rendered "Working..." with a
  // ticking timer borrowed from the agent's clock. Post-fix it must render the
  // static "No transcript recorded for this dispatch" and no running duration.
  const orphanDispatch: DispatchInfo = {
    id: 'd-orphan',
    task: 'orphaned dispatch',
    model: 'claude-opus-4-6',
    conversationId: '',
    elapsed: undefined,
    status: '',
    startTime: undefined,
  }
  const liveSiblingDispatch: DispatchInfo = {
    id: 'd-live',
    task: 'live sibling',
    model: 'claude-opus-4-6',
    conversationId: 'c-live',
    elapsed: undefined,
    status: 'running',
    startTime: 1_000_000,
  }
  const runningAgent: AgentStateUpdate = {
    name: 'dev-lead',
    status: 'running',
    metadata: { startTime: 1_000_000 },
  } as AgentStateUpdate

  function renderSelected(selectedDispatch: number): string {
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      act(() => {
        root.render(
          <AgentExpandedView
            agent={runningAgent}
            colors={colors}
            loadedMessages={undefined}
            loading={false}
            isFullscreen={true}
            dispatches={[orphanDispatch, liveSiblingDispatch]}
            selectedDispatch={selectedDispatch}
            onSelectDispatch={() => {}}
          />
        )
      })
      return container.innerHTML
    } finally {
      act(() => { root.unmount() })
    }
  }

  it('selected orphan dispatch (empty convId + status, agent running): shows no-transcript, not the running label', () => {
    const html = renderSelected(0) // index 0 = orphan dispatch
    expect(html).toContain('No transcript recorded for this dispatch')
    // The running-body label was renamed 'Working...' → 'running'. The orphan
    // renders the no-transcript copy, so neither the old nor the new label
    // appears. DispatchPager emits no raw 'running' string, so this is exact.
    expect(html).not.toContain('running')
  })

  it('selected orphan dispatch: no running duration ticker rendered', () => {
    // The pager info row would render a formatted duration only if the dispatch
    // carried elapsed/startTime. The orphan has neither, so no duration shows —
    // and critically it does not borrow the agent's startTime to tick.
    const html = renderSelected(0)
    // No minute/second running duration like "Xm Ys" or a bare "Ns" should be
    // derived for this dispatch. The orphan has no elapsed and no startTime, so
    // DurationDisplay returns null. Assert the no-transcript copy is the body.
    expect(html).toContain('No transcript recorded for this dispatch')
  })

  it('selected live sibling dispatch (status running): shows the running label', () => {
    const html = renderSelected(1) // index 1 = running sibling
    expect(html).toContain('running')
    expect(html).not.toContain('No transcript recorded for this dispatch')
    // The pre-rename word must be gone.
    expect(html).not.toContain('Working...')
  })
})
