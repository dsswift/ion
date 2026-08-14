// @vitest-environment jsdom
//
// Behavioral pins for the iOS-parity agent-panel redesign. Kept in its own file
// (not AgentPanel.test.tsx) because these assertions need a colors mock that
// yields a DISTINCT value per token — `var(--<token>)` — so the header segments
// and status dots can be pinned to their exact theme token. AgentPanel.test.tsx
// uses a single flat '#000000' mock that cannot distinguish tokens.
//
//   1. No-op click on a data-less row — a row whose agent has no dispatches, no
//      fullOutput, and is not running does NOT open the detail panel. Reverting
//      the `if (hasContent)` guard in toggleAgent turns this red.
//   2. A running row DOES open the detail panel on click — the guard does not
//      over-block. There is no preference consulted: the popup is the only
//      interaction, so reverting to a toggle-gated branch turns this red.
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

// agentPanelDefaultOpen=true auto-opens the panel so rows render on mount.
// NOTE: no agent-detail-mode key here — the floating detail panel is the only
// interaction, so the panel must not read any preference to decide.
const prefState: Record<string, unknown> = { agentPanelDefaultOpen: true }

vi.mock('../../theme', () => ({ useColors: () => COLORS }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (s: typeof prefState) => unknown) => selector(prefState),
}))
const getConversation = vi.fn().mockResolvedValue({ messages: [] })
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      dispatchActivity: {},
      agentDetailGeometry: { x: 60, y: 80, w: 600, h: 500 },
      setAgentDetailGeometry: () => {},
    }),
}))

// FloatingPanel renders children inline so the detail popup is assertable in
// the test DOM without portal/measurement machinery.
vi.mock('../FloatingPanel', () => ({
  FloatingPanel: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'floating-panel' }, children),
}))

// Import after mocks so the component graph binds the mocked modules.
import { AgentPanel } from '../AgentPanel'

beforeEach(() => {
  getConversation.mockClear()
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
  it('does NOT open the detail panel for a row with no dispatches, no fullOutput, not running', () => {
    const { container, root } = mount([dataLessDone])
    expect(container.textContent).toContain('Lonely') // row rendered (panel auto-opened)
    clickRow(container, 'Lonely')
    // Nothing to show → no detail panel mounts and no conversation fetch runs.
    // Reverting the hasContent guard makes the panel appear.
    expect(container.querySelector('[data-testid="floating-panel"]')).toBeNull()
    expect(getConversation).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  it('opens the detail panel for a running row, with no preference consulted', () => {
    const { container, root } = mount([runningAgent])
    expect(container.textContent).toContain('Worker')
    // Pre-click: no detail panel.
    expect(container.querySelector('[data-testid="floating-panel"]')).toBeNull()
    clickRow(container, 'Worker')
    // Post-click: the floating detail panel is the ONLY interaction. `prefState`
    // deliberately carries no agent-detail-mode key, so a re-introduced
    // preference branch would read undefined and fail to open this.
    expect(container.querySelector('[data-testid="floating-panel"]')).toBeTruthy()
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

describe('AgentPanel dispatch history counts', () => {
  it('shows conversation dispatch total and per-row dispatch count', () => {
    const first = { name: 'agent-1', status: 'done', metadata: { displayName: 'Agent 1', visibility: 'always', dispatches: [{ id: 'd1', status: 'done', conversationId: 'c1' }] } } as AgentStateUpdate
    const second = { name: 'agent-2', status: 'done', metadata: { displayName: 'Agent 2', visibility: 'always', dispatches: [{ id: 'd2', status: 'done', conversationId: 'c2' }, { id: 'd3', status: 'done', conversationId: 'c3' }] } } as AgentStateUpdate
    const { container, root } = mount([first, second])
    expect(container.textContent).toContain('Agents · 2')
    expect(container.textContent).toContain('3 dispatches')
    expect(container.textContent).toContain('1 dispatch')
    expect(container.textContent).toContain('2 dispatches')
    act(() => { root.unmount() })
  })
})

describe('AgentPanel detail subject parity', () => {
  it('opens start-time-most-recent dispatch when array order is non-chronological', async () => {
    getConversation.mockResolvedValue({ messages: [] })
    const lead = {
      name: 'dev-lead',
      status: 'done',
      metadata: {
        displayName: 'Dev Lead',
        visibility: 'always',
        // Latest dispatch is first. Engine slot insertion order is not
        // chronology, so array-last would load `conv-early` incorrectly.
        dispatches: [
          { id: 'd-late', conversationId: 'conv-late', status: 'done', startTime: 900 },
          { id: 'd-early', conversationId: 'conv-early', status: 'done', startTime: 100 },
        ],
      },
    } as AgentStateUpdate
    const { container, root } = mount([lead])

    clickRow(container, 'Dev Lead')
    await act(async () => { await Promise.resolve() })

    // Same dispatch AgentRow uses as foreground dot and duration must be first
    // detail load. Reverting defaults to array-last requests conv-early first.
    expect(getConversation).toHaveBeenNthCalledWith(1, 'conv-late', 0, 200)
    act(() => { root.unmount() })
  })
})

describe('AgentPanel stable popup subject', () => {
  it('keeps the opened dispatch selected when history reorders and a newer dispatch arrives', async () => {
    const initial = {
      name: 'agent', status: 'done', metadata: { displayName: 'Agent', visibility: 'always', dispatches: [
        { id: 'opened', conversationId: 'conv-opened', status: 'done', startTime: 100 },
      ] },
    } as AgentStateUpdate
    const { container, root } = mount([initial])
    clickRow(container, 'Agent')
    await act(async () => { await Promise.resolve() })
    expect(getConversation).toHaveBeenCalledWith('conv-opened', 0, 200)

    const refreshed = {
      ...initial, metadata: { ...initial.metadata, dispatches: [
        { id: 'newer', conversationId: 'conv-newer', status: 'running', startTime: 200 },
        { id: 'opened', conversationId: 'conv-opened', status: 'done', startTime: 100 },
      ] },
    } as AgentStateUpdate
    act(() => { root.render(<AgentPanel agents={[refreshed]} />) })
    expect(container.textContent).toContain('Dispatches: 2')
    // Opened subject stays #2 (its original dispatch), not the newer #1.
    const selectedButtons = Array.from(container.querySelectorAll('button')).filter(b => b.style.fontWeight === '600')
    expect(selectedButtons.some(b => b.textContent?.includes('#2'))).toBe(true)
    act(() => { root.unmount() })
  })

  it('does not repoint an open popup when its dispatch disappears', async () => {
    const initial = {
      name: 'agent', status: 'done', metadata: { displayName: 'Agent', visibility: 'always', dispatches: [
        { id: 'opened', conversationId: 'conv-opened', status: 'done', startTime: 100 },
      ] },
    } as AgentStateUpdate
    const { container, root } = mount([initial])
    clickRow(container, 'Agent')
    await act(async () => { await Promise.resolve() })
    getConversation.mockClear()

    const replacement = {
      ...initial, metadata: { ...initial.metadata, dispatches: [
        { id: 'replacement', conversationId: 'conv-replacement', status: 'done', startTime: 200 },
      ] },
    } as AgentStateUpdate
    act(() => { root.render(<AgentPanel agents={[replacement]} />) })
    expect(getConversation).not.toHaveBeenCalledWith('conv-replacement', 0, 200)
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
    // agents array still feeds the descendant walk for the yellow derivation.
    const { container, root } = mount([parent, child], { rootOnly: true })

    const dot = Array.from(container.querySelectorAll('span')).find(
      (s) => s.style.background === 'var(--statusWaitingChildren)',
    )
    expect(dot).toBeTruthy()
    expect(dot!.className).toContain('animate-pulse-dot')
    act(() => { root.unmount() })
  })

  // REGRESSION PIN for the reported bug. A lead whose MOST RECENT dispatch is
  // finished, while an OLDER dispatch still owns a running depth-2 specialist.
  //
  // Before the two-dot model this row rendered ONE solid green dot and the
  // header read "1 done" with no active segment: the row's live derivation only
  // consulted the selected dispatch (defaulting to the last array slot), so the
  // specialist hanging off the older dispatch was never found. A stalled agent
  // was indistinguishable from finished work.
  it('recent dispatch done + older dispatch still running a child: two dots, header active', () => {
    const lead = {
      name: 'dev-lead',
      status: 'done',
      metadata: {
        displayName: 'Dev Lead',
        visibility: 'always',
        dispatches: [
          { id: 'd-old', conversationId: '', status: 'done', startTime: 100 },
          { id: 'd-recent', conversationId: '', status: 'done', startTime: 200 },
        ],
      },
    } as AgentStateUpdate
    const spec = {
      name: 'code-engineer',
      status: 'running',
      metadata: { displayName: 'Code Engineer', dispatchParentId: 'd-old', dispatchDepth: 2 },
    } as AgentStateUpdate
    const { container, root } = mount([lead, spec], { rootOnly: true })

    const spans = Array.from(container.querySelectorAll('span'))
    // Foreground: the most recent dispatch, finished.
    const green = spans.find((s) => s.style.background === 'var(--statusComplete)')
    // Background: the older dispatch, still waiting on a live agent.
    const yellow = spans.find((s) => s.style.background === 'var(--statusWaitingChildren)')
    expect(green).toBeTruthy()
    expect(yellow).toBeTruthy()
    expect(yellow!.className).toContain('animate-pulse-dot')
    expect(green!.className).not.toContain('animate-pulse-dot')

    // The header must agree with the dots: the tree is not finished.
    expect(spans.some((s) => s.textContent?.includes('1 active'))).toBe(true)
    expect(spans.some((s) => s.textContent?.includes('done'))).toBe(false)
    act(() => { root.unmount() })
  })
})
