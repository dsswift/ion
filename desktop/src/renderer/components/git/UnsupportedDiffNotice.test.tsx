// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { UnsupportedDiffNotice } from './UnsupportedDiffNotice'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('UnsupportedDiffNotice', () => {
  it('explains that changed binary content is intentionally not rendered', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(<UnsupportedDiffNotice />))

    expect(container.textContent).toContain('Binary file changed')
    expect(container.textContent).toContain('This file type is not supported in Diff Viewer.')

    act(() => root.unmount())
  })
})
