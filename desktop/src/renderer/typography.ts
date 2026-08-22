export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 24
export const UI_ZOOM_MIN = 0.5
export const UI_ZOOM_MAX = 2
export const UI_ZOOM_STEP = 0.1
export const DEFAULT_MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

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

/** Apply interface zoom and compensate independent text scales for root zoom. */
export function applyTypography(root: HTMLElement, preferences: TypographyPreferences): void {
  const uiZoom = clampUiZoom(preferences.uiZoom)
  root.style.zoom = String(uiZoom)
  root.style.setProperty('--ion-ui-zoom', String(uiZoom))
  root.style.setProperty('--ion-font-mono', DEFAULT_MONO_FONT)
  root.style.setProperty('--ion-data-font-size', `${clampFontSize(preferences.dataViewFontSize) / uiZoom}px`)
  root.style.setProperty('--ion-data-code-font-size', `${clampFontSize(preferences.dataViewFontSize) / uiZoom}px`)
  root.style.setProperty('--ion-editor-font-size', `${clampFontSize(preferences.editorFontSize, 12) / uiZoom}px`)
}
