/**
 * Renderer half of typography: re-exports the pure constants/clamps from
 * `@ion/server/typography` (see that file for why they live there) and keeps
 * `applyTypography`, which mutates a live `HTMLElement`'s CSS custom
 * properties — a DOM/renderer concern with no headless equivalent.
 */
export {
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  UI_ZOOM_MIN,
  UI_ZOOM_MAX,
  UI_ZOOM_STEP,
  DEFAULT_MONO_FONT,
  clampFontSize,
  clampUiZoom,
  type TypographyPreferences,
} from '@ion/server/typography'

import { DEFAULT_MONO_FONT, clampFontSize, clampUiZoom, type TypographyPreferences } from '@ion/server/typography'

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
