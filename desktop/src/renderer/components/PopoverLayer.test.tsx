// @vitest-environment jsdom
import React, { act } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PopoverLayerProvider, usePopoverLayer } from './PopoverLayer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The popover layer reports how many popovers are open.
 *
 * A Studio browser tab is a main-process `WebContentsView`, which paints above
 * ALL page content — so a DOM popover cannot be stacked over one however high
 * its z-index. The Surface add-tab menu appeared *behind* the browser canvas
 * for exactly this reason.
 *
 * The signal lives on the layer rather than in each popover because dozens of
 * components portal here, and none of them should have to know a browser
 * exists.
 *
 * Rectangles rather than a count: main shrinks the view out from under the
 * popover, so it needs to know WHERE. Reporting only a count forced it to hide
 * the view entirely, which blanked the whole page behind a small menu.
 */
const rects = vi.fn()

let container: HTMLDivElement
let root: Root

/**
 * Portals a popover into the layer, as every real popover does.
 *
 * jsdom reports every element as zero-area, and the layer deliberately skips
 * zero-area children (a portal wrapper or a popover mid-mount occludes
 * nothing), so the rect is stubbed to make the element measurable.
 */
function Popover({ show }: { show: boolean }): React.JSX.Element | null {
  const layer = usePopoverLayer()
  if (!layer || !show) return null
  return <>{createPortal(<div ref={measurable} data-testid="pop" />, layer)}</>
}

function measurable(el: HTMLDivElement | null): void {
  if (!el) return
  el.getBoundingClientRect = () => ({ x: 10, y: 20, width: 200, height: 120, top: 20, left: 10, right: 210, bottom: 140, toJSON: () => ({}) })
}

/** The most recent reported rect list. */
function reported(): Array<{ width: number }> {
  return (rects.mock.calls.at(-1)?.[0] ?? []) as Array<{ width: number }>
}

function render(node: React.ReactNode): void {
  act(() => { root.render(<PopoverLayerProvider>{node}</PopoverLayerProvider>) })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  ;(window as unknown as { ion: unknown }).ion = { studioBrowserPopoverRects: rects }
  rects.mockClear()
  act(() => { root = createRoot(container) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('popover rectangle reporting', () => {
  it('reports nothing with no popover open', () => {
    render(<Popover show={false} />)
    expect(reported()).toEqual([])
  })

  it('reports the popover rectangle when one opens', async () => {
    render(<Popover show={false} />)
    render(<Popover show={true} />)
    // Measured on an animation frame: popovers animate in and are positioned
    // by a layout effect, so the insert-time rect is the wrong one.
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    expect(reported()).toEqual([{ x: 10, y: 20, width: 200, height: 120 }])
  })

  it('reports every overlapping popover', async () => {
    render(<><Popover show={true} /><Popover show={true} /></>)
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    // A menu with a submenu, or a tooltip over a menu: the view must clear
    // both, not just the first.
    expect(reported()).toHaveLength(2)
  })

  it('reports an empty list when the popover closes', async () => {
    render(<Popover show={true} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    render(<Popover show={false} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    expect(reported()).toEqual([])
  })

  it('clears the rectangles on unmount', () => {
    render(<Popover show={true} />)
    rects.mockClear()
    act(() => root.unmount())
    // A rect left behind would carve a permanent hole in every browser tab.
    expect(rects).toHaveBeenLastCalledWith([])
    act(() => { root = createRoot(container) })
  })
})
