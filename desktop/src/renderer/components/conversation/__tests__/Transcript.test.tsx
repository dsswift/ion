// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'
import type { Message } from '../../../../shared/types-session'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Mocks ──

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ agentPanelDefaultOpen: false, unifiedTurnView: false }),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ dispatchActivity: {} }),
}))

// Mock sub-components to render data-testid markers without their full trees.
vi.mock('../index', async () => {
  const actual = await vi.importActual('../tool-helpers') as any
  return {
    groupMessages: actual.groupMessages,
    MessageBubble: ({ message }: any) => React.createElement('div', { 'data-testid': `user-${message.id}` }, message.content),
    AssistantMessage: ({ message }: any) => React.createElement('div', { 'data-testid': `assistant-${message.id}` }, message.content),
    ToolGroup: ({ tools }: any) => React.createElement('div', { 'data-testid': 'tool-group' }, `${tools.length} tools`),
    AgentTurnGroup: () => React.createElement('div', { 'data-testid': 'agent-turn' }),
    ThinkingBlock: ({ message }: any) => React.createElement('div', { 'data-testid': `thinking-${message.id}` }),
    HarnessMessage: ({ message }: any) => React.createElement('div', { 'data-testid': `harness-${message.id}` }),
    InterceptBanner: ({ message }: any) => React.createElement('div', { 'data-testid': `intercept-${message.id}` }),
    SystemMessage: ({ message }: any) => React.createElement('div', { 'data-testid': `system-${message.id}` }),
    CompactionRow: ({ message }: any) => React.createElement('div', { 'data-testid': `compaction-${message.id}` }),
    CopyButton: () => null,
    MessageActions: () => null,
    InterruptButton: () => null,
    QueuedMessage: () => null,
    EmptyState: () => null,
  }
})

vi.mock('../../AgentPanel', () => ({
  AgentPanel: () => React.createElement('div', { 'data-testid': 'agent-panel' }),
}))

import { Transcript } from '../Transcript'

function msg(role: Message['role'], content: string, id?: string, extra?: Partial<Message>): Message {
  return {
    id: id ?? `${role}-${content.slice(0, 8)}`,
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  }
}

function renderTranscript(props: Parameters<typeof Transcript>[0]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(React.createElement(Transcript, props)) })
  return {
    container,
    unmount() {
      act(() => { root.unmount() })
      document.body.removeChild(container)
    },
  }
}

describe('Transcript', () => {
  it('renders user messages', () => {
    const { container, unmount } = renderTranscript({
      messages: [msg('user', 'Hello world', 'u1')],
      unifiedTurnView: false,
      isRunning: false,
    })
    expect(container.querySelector('[data-testid="user-u1"]')).toBeTruthy()
    unmount()
  })

  it('renders assistant messages', () => {
    const { container, unmount } = renderTranscript({
      messages: [msg('assistant', 'Hi there', 'a1')],
      unifiedTurnView: false,
      isRunning: false,
    })
    expect(container.querySelector('[data-testid="assistant-a1"]')).toBeTruthy()
    unmount()
  })

  it('renders system divider', () => {
    const { container, unmount } = renderTranscript({
      messages: [msg('system', 'Session started', 'sys1')],
      unifiedTurnView: false,
      isRunning: false,
    })
    expect(container.querySelector('[data-testid="system-sys1"]')).toBeTruthy()
    unmount()
  })

  it('renders compaction row', () => {
    const { container, unmount } = renderTranscript({
      messages: [msg('system', '[Compaction] Context compacted', 'comp1')],
      unifiedTurnView: false,
      isRunning: false,
    })
    expect(container.querySelector('[data-testid="compaction-comp1"]')).toBeTruthy()
    unmount()
  })

  it('renders harness message', () => {
    const { container, unmount } = renderTranscript({
      messages: [msg('harness', 'Bootstrap info', 'h1')],
      unifiedTurnView: false,
      isRunning: false,
    })
    expect(container.querySelector('[data-testid="harness-h1"]')).toBeTruthy()
    unmount()
  })

  it('renders intercept banner', () => {
    const { container, unmount } = renderTranscript({
      messages: [msg('harness', 'Intercepted', 'int1', { interceptLevel: 'banner' })],
      unifiedTurnView: false,
      isRunning: false,
    })
    expect(container.querySelector('[data-testid="intercept-int1"]')).toBeTruthy()
    unmount()
  })

  it('renders thinking block', () => {
    const { container, unmount } = renderTranscript({
      messages: [msg('thinking', 'Reasoning here', 'think1')],
      unifiedTurnView: false,
      isRunning: false,
    })
    expect(container.querySelector('[data-testid="thinking-think1"]')).toBeTruthy()
    unmount()
  })

  it('shows pinned prompt bar when pinnedPrompt is set', () => {
    const { container, unmount } = renderTranscript({
      messages: [],
      unifiedTurnView: false,
      isRunning: false,
      pinnedPrompt: 'Build the feature',
    })
    expect(container.textContent).toContain('Build the feature')
    expect(container.textContent).toContain(' > ')
    unmount()
  })

  it('hides pinned prompt bar when pinnedPrompt is undefined', () => {
    const { container, unmount } = renderTranscript({
      messages: [],
      unifiedTurnView: false,
      isRunning: false,
    })
    expect(container.textContent).not.toContain(' > ')
    unmount()
  })

  it('renders all message kinds in a mixed conversation', () => {
    const messages: Message[] = [
      msg('user', 'Explain this', 'u1'),
      msg('assistant', 'Sure', 'a1'),
      msg('system', 'Session divider', 's1'),
      msg('harness', 'Bootstrap', 'h1'),
      msg('thinking', 'Reasoning', 't1'),
    ]

    const { container, unmount } = renderTranscript({
      messages,
      unifiedTurnView: false,
      isRunning: false,
    })

    expect(container.querySelector('[data-testid="user-u1"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="assistant-a1"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="system-s1"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="harness-h1"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="thinking-t1"]')).toBeTruthy()
    unmount()
  })
})
