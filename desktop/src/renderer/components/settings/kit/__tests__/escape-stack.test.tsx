// @vitest-environment jsdom
/**
 * Escape closes the top-most Settings layer only: a row menu over a side
 * panel over the dialog closes one at a time, and the dialog's own document
 * listener never sees a key a layer took.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { useEscapeLayer } from '../escape-stack'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Layer({ active, onEscape }: { active: boolean; onEscape(): void }): null {
  useEscapeLayer(active, onEscape)
  return null
}

const press = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

describe('useEscapeLayer', () => {
  it('runs the newest layer first and hides the key from the dialog', () => {
    const dialog = vi.fn()
    document.addEventListener('keydown', dialog)
    const panel = vi.fn()
    const menu = vi.fn()
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<><Layer active onEscape={panel} /><Layer active onEscape={menu} /></>))
    act(press)
    expect(menu).toHaveBeenCalledTimes(1)
    expect(panel).not.toHaveBeenCalled()
    expect(dialog).not.toHaveBeenCalled()

    act(() => root.render(<><Layer active onEscape={panel} /><Layer active={false} onEscape={menu} /></>))
    act(press)
    expect(panel).toHaveBeenCalledTimes(1)
    expect(dialog).not.toHaveBeenCalled()

    act(() => root.unmount())
    act(press)
    expect(dialog).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', dialog)
  })
})
