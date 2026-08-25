// @vitest-environment jsdom
//
// Transcript's activity/Stop overlay: the control that lets a human stop the
// dispatch a transcript is CURRENTLY DISPLAYING. It must be anchored inside
// this transcript's own scroll region — not as a footer after the embedded
// AgentPanel — so it reads as "stop the conversation on screen," never as a
// control belonging to the agent panel beneath it. See the AgentDetailBody
// diff this test accompanies: the flow-footer that used to render after
// <Transcript> is gone; this overlay, INSIDE Transcript, replaces it.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

const mockAbortDispatch = vi.fn()
const mockAbortDispatches = vi.fn()
vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ dispatchActivity: {}, abortDispatch: mockAbortDispatch, abortDispatches: mockAbortDispatches }),
}))

vi.mock('../../AgentPanel', () => ({
  AgentPanel: () => React.createElement('div', { 'data-testid': 'agent-panel' }),
}))

vi.mock('../index', () => ({
  groupMessages: () => [],
}))

const dispatchStopProps: Array<Record<string, unknown>> = []
vi.mock('../../DispatchStopControl', () => ({
  DispatchStopControl: (props: Record<string, unknown>) => {
    dispatchStopProps.push(props)
    return React.createElement('button', { 'data-testid': `overlay-stop-${String(props.dispatchId)}` }, 'Stop')
  },
}))

import { Transcript } from '../Transcript'

function render(props: Partial<Parameters<typeof Transcript>[0]> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      React.createElement(Transcript, {
        messages: [],
        unifiedTurnView: false,
        isRunning: true,
        ...props,
      }),
    )
  })
  return {
    container,
    unmount() { act(() => { root.unmount() }); document.body.removeChild(container) },
  }
}

describe('Transcript activity/Stop overlay', () => {
  beforeEach(() => {
    dispatchStopProps.length = 0
    mockAbortDispatch.mockReset()
    mockAbortDispatches.mockReset()
  })

  it('renders the overlay INSIDE the scroll region, before the embedded AgentPanel in DOM order', () => {
    const { container, unmount } = render({
      tabId: 'tab-1',
      activityDispatchId: 'd1',
      activityRunningDispatchIds: ['d1'],
      activityText: 'Using Read...',
    })
    const overlay = container.querySelector('[data-testid="dispatch-activity-row"]')
    const agentPanel = container.querySelector('[data-testid="agent-panel"]')
    expect(overlay).toBeTruthy()
    expect(agentPanel).toBeTruthy()
    // DOM order: overlay's markup appears before the agent panel's markup —
    // the exact ordering property the operator flagged as backwards.
    expect(overlay!.compareDocumentPosition(agentPanel!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('[data-testid="overlay-stop-d1"]')).toBeTruthy()
    expect(container.textContent).toContain('Using Read...')
    unmount()
  })

  it('renders no overlay without a tabId', () => {
    const { container, unmount } = render({
      activityDispatchId: 'd1',
      activityRunningDispatchIds: ['d1'],
    })
    expect(container.querySelector('[data-testid="dispatch-activity-row"]')).toBeNull()
    unmount()
  })

  it('renders no overlay without an activityDispatchId', () => {
    const { container, unmount } = render({ tabId: 'tab-1' })
    expect(container.querySelector('[data-testid="dispatch-activity-row"]')).toBeNull()
    unmount()
  })

  it('stops the exact activityDispatchId, not a stale root id', () => {
    const { container, unmount } = render({
      tabId: 'tab-1',
      activityDispatchId: 'd2',
      activityRunningDispatchIds: ['d2', 'd3'],
    })
    const btn = container.querySelector('[data-testid="overlay-stop-d2"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    const props = dispatchStopProps.at(-1)
    expect(props?.dispatchId).toBe('d2')
    expect(props?.runningDispatchIds).toEqual(['d2', 'd3'])
    unmount()
  })

  it('clicking Stop calls abortDispatch with the owning tab and exact dispatch id', () => {
    const { unmount } = render({
      tabId: 'tab-owning-tree',
      activityDispatchId: 'd2',
      activityRunningDispatchIds: ['d2'],
    })
    const props = dispatchStopProps.at(-1) as { onStop: (id: string) => void }
    props.onStop('d2')
    expect(mockAbortDispatch).toHaveBeenCalledWith('tab-owning-tree', 'd2')
    unmount()
  })

  it('clicking Stop-all calls abortDispatches with every running sibling id', () => {
    const { unmount } = render({
      tabId: 'tab-owning-tree',
      activityDispatchId: 'd2',
      activityRunningDispatchIds: ['d2', 'd3'],
    })
    const props = dispatchStopProps.at(-1) as { onStopAll: (ids: string[]) => void }
    props.onStopAll(['d2', 'd3'])
    expect(mockAbortDispatches).toHaveBeenCalledWith('tab-owning-tree', ['d2', 'd3'])
    unmount()
  })
})
