// @vitest-environment jsdom
//
// Regression: Transcript must forward onOpenDispatch (and subDispatch) to its
// embedded AgentPanel. The bug renamed the prop to `_onOpenDispatch` and never
// passed it down, so clicking a child agent inside the dispatch-preview popup
// could not drill down. This pins that a click on the embedded panel's agent
// row reaches the onOpenDispatch spy.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ agentPanelDefaultOpen: true, unifiedTurnView: false }),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      agentDetailGeometry: { x: 0, y: 0, w: 600, h: 500 },
      setAgentDetailGeometry: () => {},
      dispatchActivity: {},
    }),
}))

vi.mock('../../FloatingPanel', () => ({
  FloatingPanel: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}))

// Transcript imports the conversation barrel transitively (TranscriptRows etc.);
// stub the row renderer so the embedded AgentPanel is what we assert against.
vi.mock('../conversation/TranscriptRows', () => ({
  TranscriptRows: () => null,
}))
vi.mock('../conversation/tool-helpers', () => ({
  groupMessages: () => [],
}))
vi.mock('../conversation', () => ({
  groupMessages: () => [],
  ToolGroup: () => null,
  AssistantMessage: () => null,
  MessageBubble: () => null,
  AgentTurnGroup: () => null,
  ThinkingBlock: () => null,
}))

import { Transcript } from '../conversation/Transcript'
import type { AgentStateUpdate } from '../../../shared/types'

function childStub(): AgentStateUpdate {
  return {
    name: 'engine-dev',
    status: 'done',
    metadata: {
      displayName: 'engine-dev',
      dispatches: [{ id: 'd-child', task: 'brief', model: 'claude', status: 'done', conversationId: 'conv-child', elapsed: 5 }],
    },
  } as unknown as AgentStateUpdate
}

describe('Transcript embedded AgentPanel wiring', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = {
      getConversation: vi.fn(async () => ({ messages: [], total: 0 })),
    }
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('forwards onOpenDispatch + subDispatch so clicking an embedded child row escalates', async () => {
    const onOpenDispatch = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        React.createElement(Transcript, {
          messages: [],
          unifiedTurnView: false,
          isRunning: false,
          agents: [childStub()],
          dispatchTelemetry: [],
          onOpenDispatch,
          subDispatch: true,
        }),
      )
    })
    await act(async () => { await Promise.resolve() })

    // Expand the embedded panel if collapsed.
    if (!container.textContent?.includes('engine-dev')) {
      const header = Array.from(container.querySelectorAll('div')).find((el) =>
        el.textContent?.includes('Agents ('),
      ) as HTMLElement | undefined
      if (header) await act(async () => { header.click() })
    }

    const label = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === 'engine-dev',
    ) as HTMLElement | undefined
    expect(label, 'embedded child agent should render (subDispatch shows done child)').toBeTruthy()

    await act(async () => { label!.click() })
    expect(onOpenDispatch).toHaveBeenCalledTimes(1)
    expect(onOpenDispatch.mock.calls[0][0].id).toBe('d-child')

    await act(async () => { root.unmount() })
    container.remove()
  })
})
