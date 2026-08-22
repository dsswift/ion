// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { applyTypography } from '../typography'

describe('applyTypography viewport shell', () => {
  it('publishes interface zoom without shrinking the document root', () => {
    const root = document.createElement('html')
    applyTypography(root, { uiZoom: 1.5, dataViewFontSize: 13, editorFontSize: 12 })

    expect(root.style.zoom).toBe('1.5')
    expect(root.style.getPropertyValue('--ion-ui-zoom')).toBe('1.5')
  })
})
