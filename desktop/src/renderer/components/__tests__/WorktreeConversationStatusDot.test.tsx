// @vitest-environment jsdom
/**
 * Worktree conversation rows must render the same live status indicator as tab
 * pills. These cases cover states absent from the old `DirConversation.status`
 * shortcut: unread completion, plan-ready, AskUserQuestion, and background
 * work, plus foreground running pulse behavior.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  tabs: [] as Array<Record<string, unknown>>,
  conversationPanes: new Map<string, unknown>(),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (store: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1, gitOpsMode: 'standard' }) },
}))

vi.mock('../../theme', () => ({
  useColors: () => ({
    statusIdle: '#010101', statusError: '#020202', statusPermission: '#030303',
    statusPermissionGlow: '#040404', statusRunning: '#050505',
    statusWaitingChildren: '#060606', statusWaitingChildrenGlow: '#070707',
    statusComplete: '#080808', tabGlowPlanReady: '#090909', statusQuestion: '#0a0a0a',
    tabGlowQuestion: '#0b0b0b', statusBash: '#0c0c0c', statusBashGlow: '#0d0d0d',
  }),
}))

import { WorktreeConversationStatusDot } from '../WorktreeConversationStatusDot'

const C = {
  idle: 'rgb(1, 1, 1)', running: 'rgb(5, 5, 5)', children: 'rgb(6, 6, 6)',
  complete: 'rgb(8, 8, 8)', question: 'rgb(10, 10, 10)',
} as const

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function tab(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tab-1', status: 'idle', pillIcon: null, bashExecuting: false,
    manualUnread: false, lastMessageAt: null, lastVisitedAt: null,
    ...over,
  }
}

function render(over: Record<string, unknown> = {}, pane?: unknown): HTMLElement | null {
  state.tabs = [tab(over)]
  state.conversationPanes = new Map(pane ? [['tab-1', pane]] : [])
  act(() => { root.render(<WorktreeConversationStatusDot tabId="tab-1" />) })
  return container.querySelector('[data-testid="worktree-conversation-status-tab-1"]')
}

function visual(dot: HTMLElement): HTMLElement {
  return dot.firstElementChild as HTMLElement
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('WorktreeConversationStatusDot', () => {
  it('renders idle tab status', () => {
    const dot = render()!
    expect(visual(dot).style.background).toBe(C.idle)
    expect(visual(dot).className).not.toContain('animate-pulse-dot')
  })

  it('renders foreground running with canonical pulse', () => {
    const dot = render({ status: 'running' })!
    expect(visual(dot).style.background).toBe(C.running)
    expect(visual(dot).className).toContain('animate-pulse-dot')
  })

  it('renders unread completion status', () => {
    // tabUnread (shared/inbox-classify.ts) reads lastMessageAt vs
    // lastVisitedAt — the persisted R9 derivation, not the old
    // lastCompletionAt flag.
    const dot = render({ lastMessageAt: 2, lastVisitedAt: 1 })!
    expect(visual(dot).style.background).toBe(C.complete)
    expect(visual(dot).className).not.toContain('animate-pulse-dot')
  })

  it('renders plan-ready status with canonical glow', () => {
    const dot = render({}, {
      instances: [{ permissionQueue: [], permissionDenied: { tools: [{ toolName: 'ExitPlanMode' }] }, agentStates: [] }],
    })!
    expect(visual(dot).style.background).toBe(C.complete)
    expect(visual(dot).style.boxShadow).toContain('#090909')
  })

  it('renders AskUserQuestion status with canonical glow', () => {
    const dot = render({}, {
      instances: [{ permissionQueue: [], permissionDenied: { tools: [{ toolName: 'AskUserQuestion' }] }, agentStates: [] }],
    })!
    expect(visual(dot).style.background).toBe(C.question)
    expect(visual(dot).style.boxShadow).toContain('#0b0b0b')
  })

  it('renders background-agent work with canonical pulse and glow', () => {
    const dot = render({}, {
      instances: [{ permissionQueue: [], agentStates: [{ status: 'running' }] }],
    })!
    expect(visual(dot).style.background).toBe(C.children)
    expect(visual(dot).className).toContain('animate-pulse-dot')
    expect(visual(dot).style.boxShadow).toContain('#070707')
  })

  it('renders nothing after conversation closes', () => {
    state.tabs = []
    state.conversationPanes = new Map()
    act(() => { root.render(<WorktreeConversationStatusDot tabId="tab-1" />) })
    expect(container.firstChild).toBeNull()
  })
})
