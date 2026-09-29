/**
 * settings-dialog-geometry — where the Settings dialog sits and how big it
 * is. It opens centred at its default size, clamped to the window; it can be
 * dragged, resized from its corner, and maximized to fill the window.
 */
import { zoomViewport } from '../../viewport-zoom'

export const DIALOG_WIDTH = 1100
export const DIALOG_HEIGHT = 820
export const DIALOG_MIN_WIDTH = 520
export const DIALOG_MIN_HEIGHT = 420
/** Below this width the sidebar folds into a page picker. */
export const COMPACT_LAYOUT_WIDTH = 720
const EDGE = 8
const MAXIMIZED_EDGE = 12

export type SettingsDialogLayout = 'wide' | 'compact'

export function resolveSettingsDialogLayout(width: number): SettingsDialogLayout {
  return width < COMPACT_LAYOUT_WIDTH ? 'compact' : 'wide'
}

export interface SettingsDialogGeometry {
  x: number
  y: number
  width: number
  height: number
}

export function resolveSettingsDialogGeometry(viewport = zoomViewport()): SettingsDialogGeometry {
  const width = Math.min(DIALOG_WIDTH, Math.max(0, viewport.width - EDGE * 2))
  const height = Math.min(DIALOG_HEIGHT, Math.max(0, viewport.height - EDGE * 2))
  return { x: Math.max(0, (viewport.width - width) / 2), y: Math.max(0, (viewport.height - height) / 2), width, height }
}

export function maximizedSettingsDialogGeometry(viewport = zoomViewport()): SettingsDialogGeometry {
  return { x: MAXIMIZED_EDGE, y: MAXIMIZED_EDGE, width: Math.max(0, viewport.width - MAXIMIZED_EDGE * 2), height: Math.max(0, viewport.height - MAXIMIZED_EDGE * 2) }
}

/** A corner drag: grows or shrinks from the top-left, never below the minimum or past the window. */
export function resizeSettingsDialog(start: SettingsDialogGeometry, delta: { x: number; y: number }, viewport = zoomViewport()): SettingsDialogGeometry {
  const width = Math.min(Math.max(DIALOG_MIN_WIDTH, start.width + delta.x), Math.max(DIALOG_MIN_WIDTH, viewport.width - start.x))
  const height = Math.min(Math.max(DIALOG_MIN_HEIGHT, start.height + delta.y), Math.max(DIALOG_MIN_HEIGHT, viewport.height - start.y))
  return { ...start, width, height }
}
