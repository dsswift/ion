// @vitest-environment jsdom
//
// Behavioral pins for the iOS-parity agent-panel redesign. Kept in its own file
// (not AgentPanel.test.tsx) because these assertions need a colors mock that
// yields a DISTINCT value per token — `var(--<token>)` — so the header segments
// and status dots can be pinned to their exact theme token. AgentPanel.test.tsx
// uses a single flat '#000000' mock that cannot distinguish tokens.
//
//   1. No-op click on a data-less row — a row whose agent has no dispatches, no
//      fullOutput, and is not running does NOT expand on click. Reverting the
//      `if (!hasContent) return` guard in toggleAgent turns this red (the row
//      expands into AgentExpandedView's "No transcript recorded" fallback).
//   2. A running row still expands on click — the guard does not over-block.
//   3. Header breakdown — "Agents · {total} · {active} active · {done} done",
//      zero segments dropped, active carries statusRunning, done statusComplete.
//   4. Row visual — name pill + standardized status dot (no pulse for done,
//      pulsing yellow for running-with-running-child) + no legacy status suffix.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentStateUpdate } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Each token resolves to a recognizable `var(--token)` string so inline-style
// assertions can pin the exact theme token used.
const COLORS = new Proxy({}, { get: (_t, p) => `var(--${String(p)})` })

// agentDetailPopup=false keeps toggleAgent on the inline-expand path;
// agentPanelDefaultOpen=true auto-opens the panel so rows render on mount.
const prefState: Record<string, unknown> = { agentPanelDefaultOpen: true, agentDetailPopup: false }

vi.mock('../../theme', () => ({ useColors: () => COLORS }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (s: typeof prefState) => unknown) => selector(prefState),
}))
const getConversation = vi.fn().mockResolvedValue({ messages: [] })
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { dispatchActivity: Record<string, unknown> }) => unknown) =>
    selector({ dispatchActivity: {} }),
}))

// Import after mocks so the component graph binds the mocked modules.
import { AgentPanel } from '../AgentPanel'

beforeEach(() => {
  getConversation.mockClear()
  prefState.agentDetailPopup = false
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = {
    getConversation,
    log: () => {},
  }
})

function mount(agents: AgentStateUpdate[], props: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<AgentPanel agents={agents} {...props} />)
  })
  return { container, root }
}

/** Click the row identified by its display-name pill (the click bubbles to the
 *  row container's onClick). */
function clickRow(container: HTMLElement, displayName: string) {
  const pill = Array.from(container.querySelectorAll('span')).find(
    (s) => s.textContent?.trim() === displayName,
  )
  if (!pill) throw new Error(`row pill not found: ${displayName}`)
  act(() => {
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const dataLessDone: AgentStateUpdate = {
  name: 'lonely',
  status: 'done',
  // 'always' so a completed agent stays visible (ephemeral would drop out).
  metadata: { visibility: 'always', displayName: 'Lonely' },
} as AgentStateUpdate

const runningAgent: AgentStateUpdate = {
  name: 'worker',
  status: 'running',
  metadata: { displayName: 'Worker' },
} as AgentStateUpdate

describe('AgentPanel no-op click (iOS parity)', () => {
  it('does NOT expand a row with no dispatches, no fullOutput, not running', () => {
    const { container, root } = mount([dataLessDone])
    expect(container.textContent).toContain('Lonely') // row rendered (panel auto-opened)
    clickRow(container, 'Lonely')
    // No inline expansion → the empty-transcript body never appears, and no
    // conversation fetch was attempted. Reverting the guard makes this appear.
    expect(container.textContent).not.toContain('No transcript recorded for this dispatch')
    expect(getConversation).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  it('still expands a running row on click (guard does not over-block)', () => {
    const { container, root } = mount([runningAgent])
    expect(container.textContent).toContain('Worker')
    expect(container.textContent).not.toContain('running') // pre-click: no running body
    clickRow(container, 'Worker')
    expect(container.textContent).toContain('running') // post-click: expanded running body
    act(() => { root.unmount() })
  })
})

describe('AgentPanel header breakdown', () => {
  it('shows total / active / done segments with matching status tokens', () => {
    const r1 = { name: 'r1', status: 'running', metadata: { displayName: 'R1' } } as AgentStateUpdate
    const r2 = { name: 'r2', status: 'running', metadata: { displayName: 'R2' } } as AgentStateUpdate
    const d1 = { name: 'd1', status: 'done', metadata: { visibility: 'always', displayName: 'D1' } } as AgentStateUpdate
    const { container, root } = mount([r1, r2, d1])

    const spans = Array.from(container.querySelectorAll('span'))
    const total = spans.find((s) => s.textContent?.trim() === 'Agents · 3')
    const active = spans.find((s) => s.textContent?.includes('2 active'))
    const done = spans.find((s) => s.textContent?.includes('1 done'))
    expect(total).toBeTruthy()
    expect(active).toBeTruthy()
    expect(done).toBeTruthy()
    // Each count segment carries the same token as its row dot.
    expect(active!.style.color).toBe('var(--statusRunning)')
    expect(done!.style.color).toBe('var(--statusComplete)')
    act(() => { root.unmount() })
  })

  it('drops zero segments (running-only batch shows no done segment)', () => {
    const r1 = { name: 'r1', status: 'running', metadata: { displayName: 'R1' } } as AgentStateUpdate
    const { container, root } = mount([r1])
    const spans = Array.from(container.querySelectorAll('span'))
    expect(spans.some((s) => s.textContent?.trim() === 'Agents · 1')).toBe(true)
    expect(spans.some((s) => s.textContent?.includes('active'))).toBe(true)
    expect(spans.some((s) => s.textContent?.includes('done'))).toBe(false)
    act(() => { root.unmount() })
  })
})

describe('AgentPanel row visual (pill + standardized dot, no suffix)', () => {
  it('done row: name pill + solid green dot (no pulse), no legacy status suffix', () => {
    const { container, root } = mount([dataLessDone])
    const pill = Array.from(container.querySelectorAll('span')).find((s) => s.textContent?.trim() === 'Lonely')
    expect(pill).toBeTruthy()
    // The status dot: a span with statusComplete background and no pulse class.
    const dot = Array.from(container.querySelectorAll('span')).find(
      (s) => s.style.background === 'var(--statusComplete)',
    )
    expect(dot).toBeTruthy()
    expect(dot!.className).not.toContain('animate-pulse-dot')
    // The removed running suffix must not appear on the row.
    expect(container.textContent).not.toContain('responding')
    act(() => { root.unmount() })
  })

  it('running row with a running child: pulsing yellow waiting-children dot', () => {
    const parent = {
      name: 'lead',
      status: 'running',
      metadata: {
        displayName: 'Lead',
        dispatches: [{ id: 'd-parent', conversationId: '', status: 'running' }],
      },
    } as AgentStateUpdate
    const child = {
      name: 'spec',
      status: 'running',
      metadata: { displayName: 'Spec', dispatchParentId: 'd-parent', dispatchDepth: 2 },
    } as AgentStateUpdate
    // rootOnly renders only the lead row (child is nested), while the full
    // agents array still feeds childAgentsOf for the yellow derivation.
    const { container, root } = mount([parent, child], { rootOnly: true })

    const dot = Array.from(container.querySelectorAll('span')).find(
      (s) => s.style.background === 'var(--statusWaitingChildren)',
    )
    expect(dot).toBeTruthy()
    expect(dot!.className).toContain('animate-pulse-dot')
    act(() => { root.unmount() })
  })
})
