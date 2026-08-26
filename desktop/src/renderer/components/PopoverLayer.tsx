import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'

/**
 * Popover layer — sits outside the glass pill (no overflow:hidden clipping)
 * but inside the app root (no Electron click-through issues with body portals).
 *
 * The layer itself is pointer-events:none so transparent areas stay click-through.
 * Individual popovers must set pointer-events:auto on themselves.
 *
 * The layer also reports how many popovers are open, because a Studio browser
 * tab is a main-process `WebContentsView` that paints above ALL page content:
 * no z-index can stack a DOM popover over one, so the views stop painting while
 * a popover is up. Observing the layer covers every popover at once — dozens of
 * components portal here, and none of them should have to know a browser exists.
 */

const PopoverLayerContext = createContext<HTMLDivElement | null>(null)

export function usePopoverLayer(): HTMLDivElement | null {
  return useContext(PopoverLayerContext)
}

export function PopoverLayerProvider({ children }: { children: React.ReactNode }) {
  const [layerEl, setLayerEl] = useState<HTMLDivElement | null>(null)

  const refCallback = useCallback((el: HTMLDivElement | null) => {
    setLayerEl(el)
  }, [])

  // Report each popover's RECTANGLE, not a count.
  //
  // A count made main hide the whole view, which blanked the entire page
  // behind a small menu. Sending geometry lets main shrink the view out from
  // under the popover instead, so the page keeps rendering everywhere the
  // popover is not.
  //
  // Measured on every mutation AND on animation frames while any popover is
  // open, because popovers animate in (Framer Motion) and are positioned by a
  // layout effect after their first paint — one measurement at insert time
  // would be the pre-animation rect.
  useEffect(() => {
    if (!layerEl) return
    let frame = 0
    let last = ''
    const measure = (): void => {
      const rects: Array<{ x: number; y: number; width: number; height: number }> = []
      for (const child of Array.from(layerEl.children)) {
        const rect = (child as HTMLElement).getBoundingClientRect()
        // A zero-area child is a portal wrapper or a popover mid-mount; it
        // occludes nothing, and reporting it would carve out an empty band.
        if (rect.width < 1 || rect.height < 1) continue
        rects.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      }
      const encoded = JSON.stringify(rects)
      if (encoded !== last) {
        last = encoded
        window.ion?.studioBrowserPopoverRects?.(rects)
      }
      if (rects.length > 0 || layerEl.childElementCount > 0) frame = requestAnimationFrame(measure)
      else frame = 0
    }
    const kick = (): void => { if (!frame) frame = requestAnimationFrame(measure) }
    measure()
    const observer = new MutationObserver(kick)
    observer.observe(layerEl, { childList: true })
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
      // Leaving a rect behind would carve a permanent hole in every browser.
      window.ion?.studioBrowserPopoverRects?.([])
    }
  }, [layerEl])

  return (
    <PopoverLayerContext.Provider value={layerEl}>
      {children}
      <div
        ref={refCallback}
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 9999,
        }}
      />
    </PopoverLayerContext.Provider>
  )
}
