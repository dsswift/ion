/**
 * The numbered dock chords reveal a view and never close the dock.
 *
 * These fail on the previous toggle behaviour, where pressing the chord for the
 * view already on screen wrote leftSidebarVisible: false.
 */
import { describe, expect, it } from 'vitest'
import { revealDockView } from '../dock-view-reveal'

const layout = (visible: boolean, view: 'inbox' | 'explorer' | 'git') => ({
  leftSidebarVisible: visible,
  leftSidebarView: view,
})

describe('revealDockView', () => {
  it('opens the dock on the requested view when it is closed', () => {
    const result = revealDockView(layout(false, 'inbox'), 'explorer')
    expect(result.patch).toEqual({ leftSidebarVisible: true, leftSidebarView: 'explorer' })
    expect(result.revealedSidebar).toBe(true)
    expect(result.alreadyActive).toBe(false)
  })

  it('switches view without touching visibility when another view is open', () => {
    const result = revealDockView(layout(true, 'inbox'), 'git')
    expect(result.patch).toEqual({ leftSidebarVisible: true, leftSidebarView: 'git' })
    expect(result.revealedSidebar).toBe(false)
  })

  it('is idempotent: re-selecting the visible view keeps the dock open', () => {
    const result = revealDockView(layout(true, 'git'), 'git')
    expect(result.patch.leftSidebarVisible).toBe(true)
    expect(result.patch.leftSidebarView).toBe('git')
    expect(result.alreadyActive).toBe(true)
  })

  it('never yields a closing patch, for any input state', () => {
    const views = ['inbox', 'explorer', 'git'] as const
    for (const visible of [true, false]) {
      for (const current of views) {
        for (const requested of views) {
          expect(
            revealDockView(layout(visible, current), requested).patch.leftSidebarVisible,
            `${current}->${requested} visible=${visible}`,
          ).toBe(true)
        }
      }
    }
  })
})
