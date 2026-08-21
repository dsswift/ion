import { useLayoutEffect } from 'react'
import { usePreferencesStore } from './preferences'
import { applyTypography } from './typography'

/** Applies persisted display scales in each renderer window. */
export function TypographySync(): null {
  const uiZoom = usePreferencesStore((s) => s.uiZoom)
  const dataViewFontSize = usePreferencesStore((s) => s.dataViewFontSize)
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize)

  useLayoutEffect(() => {
    applyTypography(document.documentElement, { uiZoom, dataViewFontSize, editorFontSize })
  }, [uiZoom, dataViewFontSize, editorFontSize])

  return null
}
