import { describe, expect, it } from 'vitest'
import { normalizeStudioLayout } from '../types-studio'

describe('normalizeStudioLayout sidebar view', () => {
  it('keeps every real dock view, including search', () => {
    for (const view of ['inbox', 'explorer', 'search', 'git'] as const) {
      expect(normalizeStudioLayout({ leftSidebarView: view }).leftSidebarView).toBe(view)
    }
  })

  it('falls back to the explorer for an unknown view', () => {
    expect(normalizeStudioLayout({ leftSidebarView: 'files' }).leftSidebarView).toBe('explorer')
  })
})
