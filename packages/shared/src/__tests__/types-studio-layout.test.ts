import { describe, expect, it } from 'vitest'
import { normalizeStudioLayout, STUDIO_LAYOUT_DEFAULTS } from '../types-studio'

describe('normalizeStudioLayout sidebar view', () => {
  it('keeps every real dock view, including search', () => {
    for (const view of ['inbox', 'explorer', 'search', 'git'] as const) {
      expect(normalizeStudioLayout({ leftSidebarView: view }).leftSidebarView).toBe(view)
    }
  })

  it('opens on the inbox by default', () => {
    expect(STUDIO_LAYOUT_DEFAULTS.leftSidebarView).toBe('inbox')
  })

  it('falls back to the inbox for an unknown view', () => {
    expect(normalizeStudioLayout({ leftSidebarView: 'files' }).leftSidebarView).toBe('inbox')
  })
})
