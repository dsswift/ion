import type React from 'react'
import { zoomViewport } from './viewport-zoom'

const MENU_VIEWPORT_MARGIN = 8

/** Shared zoom-aware scroll boundary for fixed context-menu roots. */
export function scrollableMenuStyle(): React.CSSProperties {
  const viewport = zoomViewport()
  return {
    boxSizing: 'border-box',
    maxHeight: Math.max(0, viewport.height - MENU_VIEWPORT_MARGIN * 2),
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  }
}
