// @vitest-environment jsdom
/**
 * DOM-order regression test for AgentTurnGroup presentation order.
 *
 * Required order: thinking → assistant text → tool-cluster header.
 *
 * Seam: compareDocumentPosition on the root container's queried nodes.
 * jsdom does not lay out flexbox, but it does maintain insertion-order DOM
 * position, which is exactly what the JSX child order controls. Querying by
 * data-testid markers on the mocked sub-components gives a stable seam: if
 * the JSX child order regresses, the position assertions flip.
 *
 * The tool-cluster header is identified by its `data-ion-ui` attribute (set
 * on the header div in AgentTurnGroup). The thinking block and assistant
 * messages are identified by the data-testid markers injected by the mocks
 * below.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Mocks ──
// Paths are relative to THIS test file at __tests__/AgentTurnGroup.test.tsx.
// ../../../ reaches renderer/; ../ reaches the conversation/ component folder.

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

vi.mock('../../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ expandToolResults: false }),
}))

vi.mock('../ThinkingBlock', () => ({
  ThinkingBlock: ({ message }: { message: { id: string } }) =>
    React.createElement('div', { 'data-testid': `thinking-${message.id}` }, 'thinking'),
}))

vi.mock('../AssistantMessage', () => ({
  AssistantMessage: ({ message }: { message: { id: string } }) =>
    React.createElement('div', { 'data-testid': `assistant-${message.id}` }, 'assistant'),
}))

vi.mock('../ToolGroup', () => ({
  ToolGroup: () => React.createElement('div', { 'data-testid': 'tool-group' }, 'tools'),
}))

vi.mock('../ToolImagesStrip', () => ({
  ToolImagesStrip: () => null,
}))

vi.mock('../CopyButton', () => ({
  CopyButton: () => null,
}))

// framer-motion: render children directly, no animation wrapper
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      React.createElement('div', rest, children),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}))

import type { Message } from '../../../../shared/types'
import { AgentTurnGroup } from '../AgentTurnGroup'

function makeMessage(id: string, role: Message['role'], content = 'text'): Message {
  return { id, role, content, timestamp: 0 }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderGroup(props: React.ComponentProps<typeof AgentTurnGroup>): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(React.createElement(AgentTurnGroup, props))
  })
  return container
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
})

// Node A precedes node B in the DOM iff (A.compareDocumentPosition(B) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

describe('AgentTurnGroup — DOM render order', () => {
  it('renders thinking → assistant text → tool-cluster header', () => {
    const thinkingMsg = makeMessage('th1', 'thinking')
    const assistantMsg = makeMessage('as1', 'assistant')
    const toolMsg = makeMessage('to1', 'tool')

    const el = renderGroup({
      thinking: thinkingMsg,
      assistantMessages: [assistantMsg],
      tools: [toolMsg],
      isActive: false,
      skipMotion: true,
    })

    const thinkingNode = el.querySelector('[data-testid="thinking-th1"]')
    const assistantNode = el.querySelector('[data-testid="assistant-as1"]')
    // The tool-cluster header is the div with data-ion-ui; it wraps the
    // "Used N tools" label and the expand toggle.
    const toolHeaderNode = el.querySelector('[data-ion-ui]')

    expect(thinkingNode, 'thinking node must be in DOM').not.toBeNull()
    expect(assistantNode, 'assistant node must be in DOM').not.toBeNull()
    expect(toolHeaderNode, 'tool-cluster header must be in DOM').not.toBeNull()

    expect(
      precedes(thinkingNode!, assistantNode!),
      'thinking must precede assistant text',
    ).toBe(true)

    expect(
      precedes(assistantNode!, toolHeaderNode!),
      'assistant text must precede tool-cluster header',
    ).toBe(true)
  })

  it('renders assistant text → tool-cluster header when no thinking block', () => {
    const assistantMsg = makeMessage('as1', 'assistant')
    const toolMsg = makeMessage('to1', 'tool')

    const el = renderGroup({
      assistantMessages: [assistantMsg],
      tools: [toolMsg],
      isActive: false,
      skipMotion: true,
    })

    const assistantNode = el.querySelector('[data-testid="assistant-as1"]')
    const toolHeaderNode = el.querySelector('[data-ion-ui]')

    expect(assistantNode).not.toBeNull()
    expect(toolHeaderNode).not.toBeNull()

    expect(
      precedes(assistantNode!, toolHeaderNode!),
      'assistant text must precede tool-cluster header',
    ).toBe(true)
  })
})

// ─── Three-state failure summary in activityHeader ───

function toolMsg(id: string, status: Message['toolStatus']): Message {
  return { id, role: 'tool', content: '', timestamp: 0, toolStatus: status }
}

describe('AgentTurnGroup — activity header three-state status', () => {
  it('renders failure count in header for mixed group when not active', () => {
    const tools = [
      toolMsg('c1', 'completed'),
      toolMsg('c2', 'completed'),
      toolMsg('e1', 'error'),
    ]

    const el = renderGroup({
      tools,
      assistantMessages: [],
      isActive: false,
      skipMotion: true,
    })

    const header = el.querySelector('[data-ion-ui]')
    expect(header).not.toBeNull()
    expect(header!.textContent).toContain('1 failed')
  })

  it('does NOT render failure text for all-success group', () => {
    const tools = [
      toolMsg('c1', 'completed'),
      toolMsg('c2', 'completed'),
    ]

    const el = renderGroup({
      tools,
      assistantMessages: [],
      isActive: false,
      skipMotion: true,
    })

    const header = el.querySelector('[data-ion-ui]')
    expect(header).not.toBeNull()
    expect(header!.textContent).not.toContain('failed')
  })
})
