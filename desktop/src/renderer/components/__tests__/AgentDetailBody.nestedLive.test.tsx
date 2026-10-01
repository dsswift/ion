// @vitest-environment jsdom
//
// A drilled-in dispatch frame stays live: its snapshot is merged with the
// push entries stored under its own dispatch id, refetched on the backstop
// interval while it runs, and refetched once more when it finishes. The
// transcript and the task list read the same merged messages.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentStateUpdate, Message } from '@ion/shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ unifiedTurnView: false }),
}))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn() }))

const store: { dispatchActivity: Record<string, Message[]> } = { dispatchActivity: {} }
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (sel: (s: typeof store) => unknown) => sel(store),
}))

const mockGetConversation = vi.fn()
;(globalThis as any).window = globalThis.window ?? {}
;(globalThis as any).window.ion = installFakeWire({ getConversation: mockGetConversation })

const transcriptMessages: Message[][] = []
vi.mock('../conversation/Transcript', () => ({
  Transcript: ({ messages, onOpenDispatch, agents }: {
    messages: Message[]
    onOpenDispatch?: (dispatch: unknown, agent: AgentStateUpdate) => void
    agents?: AgentStateUpdate[]
  }) => {
    transcriptMessages.push(messages)
    return React.createElement(
      'div',
      null,
      agents?.map((a: any, i: number) =>
        React.createElement('button', {
          key: i,
          'data-testid': `open-child-${a.name}`,
          onClick: () => onOpenDispatch?.(a.metadata?.dispatches?.[0], a),
        }),
      ),
    )
  },
}))

const todoMessages: Message[][] = []
vi.mock('../TodoListPanel', () => ({
  TodoListPanel: ({ messages }: { messages: Message[] }) => {
    todoMessages.push(messages)
    return null
  },
}))

vi.mock('@ion/shared/transcript/agent-conversation-mapper', () => ({
  mapConversationMessages: (msgs: any[]) =>
    msgs.map((m: any, i: number) => ({ id: `mapped-${i}`, role: m.role, content: m.content, timestamp: 0 })),
}))

import { AgentDetailBody } from '../AgentDetailBody'
import { RECONCILE_INTERVAL_MS } from '../../hooks/useDispatchReconcile'
import { installFakeWire } from '../../host/__tests__/fake-wire'

type Props = Parameters<typeof AgentDetailBody>[0]

const lead: AgentStateUpdate = { name: 'dev-lead', status: 'running', metadata: { displayName: 'dev-lead' } }

function child(status: 'running' | 'done'): AgentStateUpdate {
  return {
    name: 'ios-dev',
    status,
    metadata: {
      displayName: 'ios-dev',
      dispatchParentId: 'd1',
      dispatches: [{ id: 'd2', task: 't', model: 'm', conversationId: 'conv-2', status, elapsed: 1 }],
    },
  }
}

function propsWith(childStatus: 'running' | 'done'): Props {
  return {
    agent: lead,
    loadedMessages: [{ id: 'u1', role: 'user', content: 'root', timestamp: 0 }],
    loading: false,
    dispatches: [{ id: 'd1', task: 't', model: 'm', conversationId: 'conv-1', status: 'running', elapsed: 1 }],
    selectedDispatch: 0,
    onSelectDispatch: () => {},
    allAgents: [lead, child(childStatus)],
  }
}

async function renderDrilledIn(childStatus: 'running' | 'done') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(React.createElement(AgentDetailBody, propsWith(childStatus))) })
  act(() => { (container.querySelector('[data-testid="open-child-ios-dev"]') as HTMLButtonElement).click() })
  await vi.waitFor(() => {
    expect(transcriptMessages.at(-1)?.[0]?.content).toBe('child task')
  })
  return {
    rerender(next: Props) { act(() => { root.render(React.createElement(AgentDetailBody, next)) }) },
    unmount() { act(() => { root.unmount() }); container.remove() },
  }
}

describe('AgentDetailBody drilled-in frame stays live', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    store.dispatchActivity = {}
    transcriptMessages.length = 0
    todoMessages.length = 0
    mockGetConversation.mockReset()
    mockGetConversation.mockResolvedValue({ messages: [{ role: 'user', content: 'child task' }] })
  })
  afterEach(() => { vi.useRealTimers() })

  it('merges push entries stored under the child dispatch id into the transcript and task list', async () => {
    const view = await renderDrilledIn('running')
    const pushed: Message = { id: 'p1', role: 'tool', content: '', timestamp: 5, toolId: 'tool-1', toolName: 'TodoWrite' }
    store.dispatchActivity = { d2: [pushed] }
    view.rerender(propsWith('running'))

    expect(transcriptMessages.at(-1)?.map((m) => m.toolId ?? m.content)).toEqual(['child task', 'tool-1'])
    expect(todoMessages.at(-1)).toBe(transcriptMessages.at(-1))
    view.unmount()
  })

  it('refetches a running child on the backstop interval', async () => {
    const view = await renderDrilledIn('running')
    expect(mockGetConversation).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS) })
    expect(mockGetConversation).toHaveBeenCalledTimes(2)
    expect(mockGetConversation.mock.calls.at(-1)?.[0]).toMatchObject({ conversationId: 'conv-2' })
    view.unmount()
  })

  it('does not refetch a finished child', async () => {
    const view = await renderDrilledIn('done')
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 2) })
    expect(mockGetConversation).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('refetches once when the child finishes', async () => {
    const view = await renderDrilledIn('running')
    const childFetches = () =>
      mockGetConversation.mock.calls.filter(([arg]) => arg?.conversationId === 'conv-2').length
    expect(childFetches()).toBe(1)
    await act(async () => { view.rerender(propsWith('done')) })
    expect(childFetches()).toBe(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 2) })
    expect(childFetches()).toBe(2)
    view.unmount()
  })
})
