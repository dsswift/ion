import { describe, expect, it, vi } from 'vitest'

vi.mock('../../viewport-zoom', () => ({ zoomViewport: () => ({ width: 900, height: 240 }) }))

import { scrollableMenuStyle } from '../../menu-viewport'

describe('scrollableMenuStyle', () => {
  it('caps oversized context menus to the zoom-adjusted viewport', () => {
    expect(scrollableMenuStyle()).toEqual({
      boxSizing: 'border-box',
      maxHeight: 224,
      overflowY: 'auto',
      overscrollBehavior: 'contain',
    })
  })
})
