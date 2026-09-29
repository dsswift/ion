/**
 * typography — pure constants and clamp helpers for UI zoom and font sizing.
 *
 * Split from desktop/src/renderer/typography.ts: `applyTypography` mutates a
 * live `HTMLElement`'s CSS custom properties, which is a DOM/renderer concern
 * with no headless equivalent, so it stays in desktop and re-exports these
 * pure pieces alongside it. Everything here has zero DOM dependency — plain
 * constants and arithmetic — so it is shared as the one source of truth for
 * both the renderer and any headless consumer (e.g. `preferences-types.ts`,
 * which needs `DEFAULT_MONO_FONT` for its settings defaults).
 */
export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 24
export const UI_ZOOM_MIN = 0.5
export const UI_ZOOM_MAX = 2
export const UI_ZOOM_STEP = 0.1
export const DEFAULT_MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", Consolas, monospace'

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

export function clampFontSize(value: number, fallback = 13): number {
  return Math.round(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, finite(value, fallback))))
}

export function clampUiZoom(value: number, fallback = 1): number {
  return Math.round(Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, finite(value, fallback))) * 10) / 10
}

export interface TypographyPreferences {
  uiZoom: number
  dataViewFontSize: number
  editorFontSize: number
}
