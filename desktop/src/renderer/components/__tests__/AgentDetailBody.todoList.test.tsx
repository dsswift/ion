// @vitest-environment jsdom
//
// AgentDetailBody mounts the displayed dispatch's task list: forced visible,
// fed the current breadcrumb frame's messages, so drilling into a child swaps
// the list to that child's.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentStateUpdate, Message } from '@ion/shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ unifiedTurnView: false, showTodoList: false }),
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ dispatchActivity: {} }),
}))

const mockGetConversation = vi.fn()
;(globalThis as any).window = globalThis.window ?? {}
;(globalThis as any).window.ion = installFakeWire({ getConversation: mockGetConversation })

vi.mock('../conversation/Transcript', () => ({
  Transcript: ({ onOpenDispatch, agents }: {
    onOpenDispatch?: (dispatch: unknown, agent: AgentStateUpdate) => void
    agents?: AgentStateUpdate[]
  }) =>
    React.createElement(
      'div',
      null,
      agents?.map((a: any, i: number) =>
        React.createElement('button', {
          key: i,
          'data-testid': `open-child-${a.name}`,
          onClick: () => onOpenDispatch?.(a.metadata?.dispatches?.[0], a),
        }),
      ),
    ),
}))

const todoProps: Array<{ messages: Message[]; alwaysShow?: boolean }> = []
vi.mock('../TodoListPanel', () => ({
  TodoListPanel: (props: { messages: Message[]; alwaysShow?: boolean }) => {
    todoProps.push(props)
    return null
  },
}))

vi.mock('@ion/shared/transcript/agent-conversation-mapper', () => ({
  mapConversationMessages: (msgs: any[]) =>
    msgs.map((m: any, i: number) => ({ id: `mapped-${i}`, role: m.role, content: m.content, timestamp: 0 })),
}))

import { AgentDetailBody } from '../AgentDetailBody'
import { installFakeWire } from '../../host/__tests__/fake-wire'

const rootMessages: Message[] = [{ id: 'u1', role: 'user', content: 'root task', timestamp: 0 }]

function renderBody(props: Parameters<typeof AgentDetailBody>[0]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(React.createElement(AgentDetailBody, props)) })
  return { container, unmount() { act(() => { root.unmount() }); container.remove() } }
}

const baseProps: Parameters<typeof AgentDetailBody>[0] = {
  agent: { name: 'dev-lead', status: 'done', metadata: { displayName: 'dev-lead' } },
  loadedMessages: rootMessages,
  loading: false,
  dispatches: [{ id: 'd1', task: 't', model: 'm', conversationId: 'conv-1', status: 'done', elapsed: 1 }],
  selectedDispatch: 0,
  onSelectDispatch: () => {},
}

describe('AgentDetailBody task list', () => {
  beforeEach(() => {
    todoProps.length = 0
    mockGetConversation.mockReset()
    mockGetConversation.mockResolvedValue({ messages: [{ role: 'user', content: 'child task' }] })
  })

  it('shows the root dispatch task list regardless of the preference', () => {
    const { unmount } = renderBody(baseProps)
    expect(todoProps.at(-1)?.messages).toBe(rootMessages)
    expect(todoProps.at(-1)?.alwaysShow).toBe(true)
    unmount()
  })

  it('renders no task list while the frame is loading', () => {
    const { unmount } = renderBody({ ...baseProps, loading: true })
    expect(todoProps).toHaveLength(0)
    unmount()
  })

  it('swaps to the child conversation messages after drilling in', async () => {
    const child: AgentStateUpdate = {
      name: 'ios-dev',
      status: 'done',
      metadata: {
        displayName: 'ios-dev',
        dispatchParentId: 'd1',
        dispatches: [{ id: 'd2', task: 't', model: 'm', conversationId: 'conv-2', status: 'done', elapsed: 1 }],
      },
    }
    const { container, unmount } = renderBody({ ...baseProps, allAgents: [baseProps.agent, child] })
    act(() => { (container.querySelector('[data-testid="open-child-ios-dev"]') as HTMLButtonElement).click() })
    await vi.waitFor(() => {
      expect(todoProps.at(-1)?.messages[0]?.content).toBe('child task')
    })
    unmount()
  })
})
