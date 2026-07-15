// @vitest-environment jsdom
/**
 * ToolGroup collapsed-row three-state status tests.
 * Verifies that:
 *  - Mixed failure group renders ", M failed" suffix in the collapsed row.
 *  - All-success group does NOT render any failure text.
 *  - Running group suppresses failure suffix even when errors are present.
 */

import { describe, it, expect, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

vi.mock('../../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ expandToolResults: false }),
}))

vi.mock('../ToolRow', () => ({
  ToolRow: () => null,
}))

vi.mock('../ToolImagesStrip', () => ({
  ToolImagesStrip: () => null,
}))

vi.mock('../ToolIcon', () => ({
  ToolIcon: () => null,
}))

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      React.createElement('div', rest, children),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}))

import type { Message } from '../../../../shared/types'
import { ToolGroup } from '../ToolGroup'

function toolMsg(id: string, status: Message['toolStatus'], name = 'Read'): Message {
  return { id, role: 'tool', content: '', timestamp: 0, toolStatus: status, toolName: name }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderGroup(tools: Message[]): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(React.createElement(ToolGroup, { tools, skipMotion: true }))
  })
  return container
}

function cleanup() {
  act(() => { root?.unmount() })
  root = null
  container?.remove()
  container = null
}

describe('ToolGroup collapsed three-state status', () => {
  it('renders failure count for mixed group', () => {
    const tools = [
      ...Array.from({ length: 97 }, (_, i) => toolMsg(`ok-${i}`, 'completed')),
      toolMsg('e1', 'error'),
      toolMsg('e2', 'error'),
      toolMsg('e3', 'error'),
    ]
    const el = renderGroup(tools)
    // Collapsed by default (expandToolResults=false, no userExecuted)
    const text = el.textContent ?? ''
    expect(text).toContain('3 failed')
    cleanup()
  })

  it('does NOT render failure text for all-success group', () => {
    const tools = [
      toolMsg('t1', 'completed'),
      toolMsg('t2', 'completed'),
      toolMsg('t3', 'completed'),
    ]
    const el = renderGroup(tools)
    const text = el.textContent ?? ''
    expect(text).not.toContain('failed')
    cleanup()
  })

  it('suppresses failure suffix while tools are still running', () => {
    const tools = [
      toolMsg('c1', 'completed'),
      toolMsg('r1', 'running'),
      toolMsg('e1', 'error'),
    ]
    const el = renderGroup(tools)
    const text = el.textContent ?? ''
    expect(text).not.toContain('failed')
    cleanup()
  })

  it('renders "all failed" for all-failed group', () => {
    const tools = [
      toolMsg('e1', 'error'),
      toolMsg('e2', 'error'),
    ]
    const el = renderGroup(tools)
    const text = el.textContent ?? ''
    expect(text).toContain('all failed')
    cleanup()
  })
})
