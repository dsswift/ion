// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { StackedDiffFile } from '../StackedDiffFile'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  ;(window as unknown as { ion: unknown }).ion = {
    gitStage: vi.fn().mockResolvedValue({ ok: true }),
    gitUnstage: vi.fn().mockResolvedValue({ ok: true }),
  }
})

describe('StackedDiffFile', () => {
  it('keeps a binary change visible but never renders its payload as diff lines', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <StackedDiffFile
          repoDir="/repo"
          file={{ path: 'asset.bin', staged: false, status: 'modified' }}
          diff="raw binary payload must not render"
          diffState="ready"
          isBinary
          onRefresh={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain('asset.bin')
    expect(container.textContent).toContain('Binary file changed')
    expect(container.textContent).toContain('This file type is not supported in Diff Viewer.')
    expect(container.textContent).not.toContain('raw binary payload must not render')
    expect(container.textContent).not.toContain('+0')
    expect(container.textContent).not.toContain('−0')

    act(() => root.unmount())
  })
})
