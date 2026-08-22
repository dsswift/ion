// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ColorPalette } from '../../theme'
import { ContextCapacityNotice } from '../ContextCapacityNotice'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('framer-motion', () => ({
  motion: { div: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} /> },
}))

const colors = {
  dangerFg: 'rgb(200, 0, 0)',
  accent: 'rgb(0, 100, 200)',
} as unknown as ColorPalette

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ContextCapacityNotice', () => {
  it('renders no early compaction hint', () => {
    act(() => {
      root.render(
        <ContextCapacityNotice
          state="warning"
          colors={colors}
          onNewConversation={vi.fn()}
        />,
      )
    })

    expect(host.innerHTML).toBe('')
  })

  it('keeps recovery choices when context is full', () => {
    act(() => {
      root.render(
        <ContextCapacityNotice
          state="full"
          colors={colors}
          onNewConversation={vi.fn()}
        />,
      )
    })

    expect(host.textContent).toContain('Context is full')
    expect(host.textContent).toContain('/compact')
  })
})
