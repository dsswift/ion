// @vitest-environment jsdom
//
// Regression test for the double-nested "Used N tools" header in the unified
// turn view. AgentTurnGroup owns the turn's collapse header and only mounts
// ToolGroup when its own row is expanded; ToolGroup was *also* rendering its
// own "Used N tools" header above the tool rows, so an expanded turn showed two
// stacked headers (see screenshots in the originating issue).
//
// The fix adds an `embedded` prop: when set (only by AgentTurnGroup), ToolGroup
// renders the tool rows directly with no own header and no collapsed summary.
// These tests pin that:
//   - embedded  => no "Used N tools" header text, rows still render.
//   - standalone => the "Used N tools" header IS present when open.
// Reverting the `embedded` guard turns the embedded assertion red.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'
import type { Message } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// useColors yields a color for any key; preferences exposes expandToolResults.
vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))
vi.mock('../../preferences', () => {
  const store = (selector: (s: { expandToolResults: boolean }) => unknown) =>
    selector({ expandToolResults: false })
  store.getState = () => ({ expandToolResults: false, planModelSplitEnabled: false, planModeModel: null, defaultModel: null })
  return { usePreferencesStore: store }
})

// Keep the test focused on the header layer — stub the row/icon leaves so the
// assertion isn't entangled with InlineEditDiff and the full icon set.
vi.mock('../conversation/ToolRow', () => ({
  ToolRow: ({ desc }: { desc: string }) => <div data-testid="tool-row">{desc}</div>,
}))
vi.mock('../conversation/ToolIcon', () => ({
  ToolIcon: () => <span data-testid="tool-icon" />,
}))

import { ToolGroup } from '../conversation/ToolGroup'

function tool(id: string, name: string): Message {
  return {
    id,
    role: 'tool',
    content: '',
    toolName: name,
    toolInput: '',
    toolStatus: 'completed',
    timestamp: 0,
  } as Message
}

function render(props: React.ComponentProps<typeof ToolGroup>): string {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => {
      root.render(<ToolGroup {...props} />)
    })
    return container.innerHTML
  } finally {
    act(() => {
      root.unmount()
    })
  }
}

function errorTool(id: string): Message {
  return {
    id,
    role: 'tool',
    content: '',
    toolName: 'Bash',
    toolInput: '',
    toolStatus: 'error',
    timestamp: 0,
  } as Message
}

const tools = [tool('t0', 'Read'), tool('t1', 'Edit'), tool('t2', 'Bash')]

describe('ToolGroup embedded mode', () => {
  it('renders no "Used N tools" header when embedded, but still renders the rows', () => {
    const html = render({ tools, skipMotion: true, embedded: true })
    // No own collapse header in embedded mode — the parent owns it.
    expect(html).not.toContain('Used 3 tools')
    // Tool rows are still rendered directly.
    const rows = (html.match(/data-testid="tool-row"/g) || []).length
    expect(rows).toBe(tools.length)
  })

  it('renders no header when embedded regardless of tool count', () => {
    const single = render({ tools: [tool('only', 'Read')], skipMotion: true, embedded: true })
    expect(single).not.toContain('Used 1 tool')
    expect((single.match(/data-testid="tool-row"/g) || []).length).toBe(1)
  })

  it('renders its own "Used N tools" header when standalone (not embedded) and open', () => {
    // Standalone groups start collapsed; expand by clicking the summary row.
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      act(() => {
        root.render(<ToolGroup tools={tools} skipMotion />)
      })
      // Collapsed: shows the summary, not the open-state header.
      expect(container.innerHTML).not.toContain('Used 3 tools')
      const summary = container.querySelector('[data-ion-ui]') as HTMLElement
      act(() => {
        summary.click()
      })
      // Open: the standalone header IS present.
      expect(container.innerHTML).toContain('Used 3 tools')
    } finally {
      act(() => {
        root.unmount()
      })
    }
  })
})

describe('ToolGroup collapsed — three-state failure summary', () => {
  it('shows failure count when group has errors', () => {
    // 100 tools: 3 error, 97 completed. Collapsed (no userExecuted, no expandToolResults).
    const mixed: Message[] = []
    for (let i = 0; i < 97; i++) mixed.push(tool(`c${i}`, 'Read'))
    for (let i = 0; i < 3; i++) mixed.push(errorTool(`e${i}`))

    const html = render({ tools: mixed, skipMotion: true })
    // Collapsed summary must contain the failure count.
    expect(html).toMatch(/3 failed/)
  })

  it('does NOT show failure text when all tools completed', () => {
    const allOk: Message[] = []
    for (let i = 0; i < 5; i++) allOk.push(tool(`c${i}`, 'Read'))

    const html = render({ tools: allOk, skipMotion: true })
    expect(html).not.toMatch(/failed/)
  })
})
