import React, { createContext, useContext, useState, useCallback } from 'react'

/**
 * Popover layer — sits outside the glass pill (no overflow:hidden clipping)
 * but inside the app root (no Electron click-through issues with body portals).
 *
 * The layer itself is pointer-events:none so transparent areas stay click-through.
 * Individual popovers must set pointer-events:auto on themselves.
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
