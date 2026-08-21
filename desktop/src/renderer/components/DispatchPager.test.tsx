// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStateUpdate } from '../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../theme', () => ({
  useColors: () => ({
    textTertiary: '#010101', textPrimary: '#020202', surfacePressed: '#030303',
    surfaceHover: '#040404', tabActiveBorder: '#050505', borderSubtle: '#060606',
    statusRunning: '#070707', statusWaitingChildren: '#080808',
    statusWaitingChildrenGlow: '#090909', statusBash: '#0d0d0d',
    statusBashGlow: '#0e0e0e', statusComplete: '#0a0a0a',
    statusError: '#0b0b0b', statusIdle: '#0c0c0c',
  }),
}))

vi.mock('./TabStripShared', () => ({ PILL_ICON_MAP: {} }))

import { DispatchPager } from './DispatchPager'

const colors = {
  running: 'rgb(7, 7, 7)',
  waiting: 'rgb(8, 8, 8)',
  complete: 'rgb(10, 10, 10)',
} as const

function agent(dispatches: Array<Record<string, unknown>>): AgentStateUpdate {
  return {
    name: 'lead',
    status: 'done',
    metadata: { dispatches },
  } as unknown as AgentStateUpdate
}

function render(agentState: AgentStateUpdate, allAgents: AgentStateUpdate[] = [agentState]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const dispatches = agentState.metadata?.dispatches as unknown as Parameters<typeof DispatchPager>[0]['dispatches']
  act(() => {
    root.render(
      <DispatchPager
        agent={agentState}
        allAgents={allAgents}
        dispatches={dispatches}
        selectedIndex={0}
        onSelect={() => {}}
      />,
    )
  })
  return { container, root }
}

function dotFor(container: HTMLElement, label: string): HTMLElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label),
  )
  if (!button) throw new Error(`missing ${label}`)
  const dot = Array.from(button.querySelectorAll('span')).find((candidate) => candidate.style.background)
  if (!dot) throw new Error(`missing dot for ${label}`)
  return dot as HTMLElement
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('DispatchPager status dots', () => {
  it('renders running dispatch with canonical running color and pulse', () => {
    const lead = agent([{ id: 'running', status: 'running' }])
    const { container, root } = render(lead)
    const dot = dotFor(container, '#1')
    expect(dot.style.background).toBe(colors.running)
    expect(dot.className).toContain('animate-pulse-dot')
    act(() => { root.unmount() })
  })

  it('renders completed dispatch with canonical complete color and no pulse', () => {
    const lead = agent([{ id: 'done', status: 'done' }])
    const { container, root } = render(lead)
    const dot = dotFor(container, '#1')
    expect(dot.style.background).toBe(colors.complete)
    expect(dot.className).not.toContain('animate-pulse-dot')
    act(() => { root.unmount() })
  })

  it('renders a terminal legacy dispatch with a live descendant as waiting children', () => {
    const lead = agent([{ id: 'parent', status: 'done' }])
    const child = {
      name: 'specialist',
      status: 'running',
      metadata: { dispatchParentId: 'parent' },
    } as AgentStateUpdate
    const { container, root } = render(lead, [lead, child])
    const dot = dotFor(container, '#1')
    expect(dot.style.background).toBe(colors.waiting)
    expect(dot.className).toContain('animate-pulse-dot')
    expect(dot.style.boxShadow).toContain('#090909')
    act(() => { root.unmount() })
  })
})
