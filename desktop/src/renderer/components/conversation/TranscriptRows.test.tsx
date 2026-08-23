// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'
import type { Message } from '../../../shared/types-session'
import type { GroupedItem } from './tool-helpers'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Count renders per message id through mocked row components. memo() skips
// the wrapped component entirely, so a counter incrementing means the row
// actually re-rendered (and in production would re-parse its markdown).
const renderCounts = new Map<string, number>()
function countRender(id: string) {
  renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1)
}

vi.mock('./index', () => ({
  MessageBubble: ({ message }: { message: Message }) => {
    countRender(message.id)
    return React.createElement('div', { 'data-testid': `user-${message.id}` })
  },
  AssistantMessage: ({ message }: { message: Message }) => {
    countRender(message.id)
    return React.createElement('div', { 'data-testid': `assistant-${message.id}` })
  },
  ToolGroup: ({ tools }: { tools: Message[] }) => {
    countRender(tools[0].id)
    return React.createElement('div', { 'data-testid': `tools-${tools[0].id}` })
  },
  BackgroundWorkGroup: () => null,
  AgentTurnGroup: ({ tools }: { tools: Message[] }) => {
    countRender(tools[0]?.id ?? 'turn')
    return React.createElement('div', { 'data-testid': 'agent-turn' })
  },
  ThinkingBlock: ({ message }: { message: Message }) => {
    countRender(message.id)
    return React.createElement('div', { 'data-testid': `thinking-${message.id}` })
  },
  HarnessMessage: () => null,
  InterceptBanner: () => null,
  SystemMessage: ({ message }: { message: Message }) => {
    countRender(message.id)
    return React.createElement('div', { 'data-testid': `system-${message.id}` })
  },
  CompactionRow: () => null,
}))

import { TranscriptRows, groupedItemsEqual } from './TranscriptRows'

function msg(id: string, role: Message['role'], content: string, extra?: Partial<Message>): Message {
  return { id, role, content, timestamp: 1, ...extra }
}

function render(grouped: GroupedItem[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(React.createElement(TranscriptRows, { grouped })) })
  return {
    container,
    rerender(next: GroupedItem[]) {
      act(() => { root.render(React.createElement(TranscriptRows, { grouped: next })) })
    },
    unmount() {
      act(() => { root.unmount() })
      document.body.removeChild(container)
    },
  }
}

describe('groupedItemsEqual', () => {
  it('message rows compare by message reference', () => {
    const m = msg('u1', 'user', 'hi')
    expect(groupedItemsEqual({ kind: 'user', message: m }, { kind: 'user', message: m })).toBe(true)
    expect(
      groupedItemsEqual({ kind: 'user', message: m }, { kind: 'user', message: { ...m } }),
    ).toBe(false)
  })

  it('kind mismatch is never equal', () => {
    const m = msg('x1', 'user', 'hi')
    expect(
      groupedItemsEqual({ kind: 'user', message: m }, { kind: 'system', message: m }),
    ).toBe(false)
  })

  it('tool-groups compare by member identity, not array identity', () => {
    const t1 = msg('t1', 'tool', '', { toolName: 'Read' })
    const t2 = msg('t2', 'tool', '', { toolName: 'Bash' })
    expect(
      groupedItemsEqual(
        { kind: 'tool-group', messages: [t1, t2] },
        { kind: 'tool-group', messages: [t1, t2] },
      ),
    ).toBe(true)
    expect(
      groupedItemsEqual(
        { kind: 'tool-group', messages: [t1, t2] },
        { kind: 'tool-group', messages: [t1, { ...t2 }] },
      ),
    ).toBe(false)
    expect(
      groupedItemsEqual(
        { kind: 'tool-group', messages: [t1] },
        { kind: 'tool-group', messages: [t1, t2] },
      ),
    ).toBe(false)
  })

  it('standalone thinking rows compare by field, not reference', () => {
    // A no-tools turn in unified view emits { kind: 'thinking', message: merged }
    // where merged is synthesized fresh each grouping pass — field equality
    // must hold when nothing changed.
    const think = msg('th1', 'thinking', 'reasoning', {
      thinkingActive: false,
      thinkingElapsedSeconds: 4,
      thinkingTotalTokens: 120,
    })
    expect(
      groupedItemsEqual(
        { kind: 'thinking', message: think },
        { kind: 'thinking', message: { ...think } },
      ),
    ).toBe(true)
    expect(
      groupedItemsEqual(
        { kind: 'thinking', message: think },
        { kind: 'thinking', message: { ...think, content: 'reasoning grew' } },
      ),
    ).toBe(false)
    expect(
      groupedItemsEqual(
        { kind: 'thinking', message: think },
        { kind: 'thinking', message: { ...think, thinkingActive: true } },
      ),
    ).toBe(false)
  })

  it('agent-turns compare members, isActive, and merged-thinking fields', () => {
    const t1 = msg('t1', 'tool', '')
    const a1 = msg('a1', 'assistant', 'done')
    const think = msg('th1', 'thinking', 'reasoning', { thinkingActive: false })
    const base: GroupedItem = {
      kind: 'agent-turn', tools: [t1], assistantMessages: [a1], isActive: false, thinking: think,
    }
    // Synthesized merged-thinking rows are fresh objects each pass — field
    // equality must hold when the fields match.
    expect(
      groupedItemsEqual(base, {
        kind: 'agent-turn', tools: [t1], assistantMessages: [a1], isActive: false,
        thinking: { ...think },
      }),
    ).toBe(true)
    expect(
      groupedItemsEqual(base, {
        kind: 'agent-turn', tools: [t1], assistantMessages: [a1], isActive: false,
        thinking: { ...think, content: 'reasoning grew' },
      }),
    ).toBe(false)
    expect(
      groupedItemsEqual(base, {
        kind: 'agent-turn', tools: [t1], assistantMessages: [a1], isActive: true, thinking: think,
      }),
    ).toBe(false)
  })
})

describe('TranscriptRows memoization', () => {
  it('rebuilt grouped array with unchanged message refs re-renders no rows', () => {
    renderCounts.clear()
    const u1 = msg('u1', 'user', 'question')
    const a1 = msg('a1', 'assistant', 'answer')
    const t1 = msg('t1', 'tool', '', { toolName: 'Read' })

    const build = (): GroupedItem[] => [
      { kind: 'user', message: u1 },
      { kind: 'tool-group', messages: [t1] },
      { kind: 'assistant', message: a1 },
    ]

    const { rerender, unmount } = render(build())
    expect(renderCounts.get('u1')).toBe(1)
    expect(renderCounts.get('a1')).toBe(1)
    expect(renderCounts.get('t1')).toBe(1)

    // Streaming rebuilds the grouped array every chunk; unchanged refs must
    // not re-render (this is what replaced the pagination render cap).
    rerender(build())
    expect(renderCounts.get('u1')).toBe(1)
    expect(renderCounts.get('a1')).toBe(1)
    expect(renderCounts.get('t1')).toBe(1)
    unmount()
  })

  it('virtualizes large transcripts so first paint mounts only a bounded row window', () => {
    renderCounts.clear()
    const grouped = Array.from({ length: 4_000 }, (_, index): GroupedItem => ({
      kind: 'user', message: msg(`u-${index}`, 'user', `message ${index}`),
    }))
    const viewport = document.createElement('div')
    Object.defineProperty(viewport, 'clientHeight', { value: 600 })
    Object.defineProperty(viewport, 'clientWidth', { value: 800 })
    Object.defineProperty(viewport, 'scrollHeight', { value: 288_000, configurable: true })
    document.body.appendChild(viewport)
    const container = document.createElement('div')
    viewport.appendChild(container)
    const root = createRoot(container)
    const scrollRef = { current: viewport }

    act(() => { root.render(React.createElement(TranscriptRows, { grouped, scrollRef })) })

    expect(container.querySelector('[data-testid="virtual-transcript-rows"]')).not.toBeNull()
    expect(renderCounts.size).toBeGreaterThan(0)
    expect(renderCounts.size).toBeLessThan(100)
    expect(renderCounts.has('u-3999')).toBe(true)
    expect(renderCounts.has('u-0')).toBe(false)
    act(() => { root.unmount() })
    document.body.removeChild(viewport)
  })

  it('exposes an exact virtual row jump for an unmounted middle user message', () => {
    renderCounts.clear()
    const grouped = Array.from({ length: 4_000 }, (_, index): GroupedItem => ({
      kind: 'user', message: msg(`jump-${index}`, 'user', `message ${index}`),
    }))
    const viewport = document.createElement('div')
    Object.defineProperty(viewport, 'clientHeight', { value: 600 })
    Object.defineProperty(viewport, 'clientWidth', { value: 800 })
    Object.defineProperty(viewport, 'scrollHeight', { value: 288_000, configurable: true })
    Object.defineProperty(viewport, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(viewport, 'scrollTo', {
      value: ({ top }: ScrollToOptions) => { viewport.scrollTop = top ?? 0 },
    })
    document.body.appendChild(viewport)
    const container = document.createElement('div')
    viewport.appendChild(container)
    const root = createRoot(container)
    const virtualMessageJumpRef = { current: null as ((messageId: string) => boolean) | null }

    act(() => {
      root.render(React.createElement(TranscriptRows, {
        grouped,
        scrollRef: { current: viewport },
        virtualMessageJumpRef,
      }))
    })
    expect(renderCounts.has('jump-2000')).toBe(false)

    let resolved = false
    act(() => { resolved = virtualMessageJumpRef.current?.('jump-2000') ?? false })

    expect(resolved).toBe(true)
    expect(viewport.scrollTop).toBeGreaterThan(0)
    act(() => { root.unmount() })
    expect(virtualMessageJumpRef.current).toBeNull()
    document.body.removeChild(viewport)
  })

  it('opens hydrated virtual history at the last row after an empty skeleton mount', () => {
    renderCounts.clear()
    const grouped = Array.from({ length: 4_000 }, (_, index): GroupedItem => ({
      kind: 'user', message: msg(`hydrated-${index}`, 'user', `message ${index}`),
    }))
    const viewport = document.createElement('div')
    Object.defineProperty(viewport, 'clientHeight', { value: 600 })
    Object.defineProperty(viewport, 'clientWidth', { value: 800 })
    Object.defineProperty(viewport, 'scrollHeight', { value: 288_000, configurable: true })
    Object.defineProperty(viewport, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(viewport, 'scrollTo', {
      value: ({ top }: ScrollToOptions) => {
        viewport.scrollTop = top ?? 0
      },
    })
    document.body.appendChild(viewport)
    const container = document.createElement('div')
    viewport.appendChild(container)
    const root = createRoot(container)
    const scrollRef = { current: viewport }

    act(() => { root.render(React.createElement(TranscriptRows, { grouped: [], scrollRef })) })
    act(() => { root.render(React.createElement(TranscriptRows, { grouped, scrollRef })) })

    expect(renderCounts.has('hydrated-3999')).toBe(true)
    expect(renderCounts.has('hydrated-0')).toBe(false)
    expect(viewport.scrollTop).toBeGreaterThan(0)
    act(() => { root.unmount() })
    document.body.removeChild(viewport)
  })

  it('only the row whose message changed re-renders', () => {
    renderCounts.clear()
    const u1 = msg('u1', 'user', 'question')
    const a1 = msg('a1', 'assistant', 'streaming…')

    const { rerender, unmount } = render([
      { kind: 'user', message: u1 },
      { kind: 'assistant', message: a1 },
    ])

    // A chunk arrives: the store replaces the streaming message object.
    rerender([
      { kind: 'user', message: u1 },
      { kind: 'assistant', message: { ...a1, content: 'streaming… more' } },
    ])
    expect(renderCounts.get('u1')).toBe(1)
    expect(renderCounts.get('a1')).toBe(2)
    unmount()
  })

  it('a fresh but field-equal merged thinking row does not re-render', () => {
    renderCounts.clear()
    const think = msg('th1', 'thinking', 'reasoning', {
      thinkingActive: false,
      thinkingElapsedSeconds: 4,
    })

    const { rerender, unmount } = render([{ kind: 'thinking', message: think }])
    expect(renderCounts.get('th1')).toBe(1)

    // mergeThinkingMessages synthesizes a fresh object every grouping pass;
    // an unchanged turn must not re-render its ThinkingBlock.
    rerender([{ kind: 'thinking', message: { ...think } }])
    expect(renderCounts.get('th1')).toBe(1)

    // A real content change (new delta) does re-render.
    rerender([{ kind: 'thinking', message: { ...think, content: 'reasoning grew' } }])
    expect(renderCounts.get('th1')).toBe(2)
    unmount()
  })
})
