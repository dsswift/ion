/**
 * `restoreGlobalGeometry` runs in the headless server process at boot
 * (ADR-033) and previously threw `ReferenceError: window is not defined`
 * because it clamped restored geometry against `window.innerWidth`/
 * `innerHeight` -- a browser global that never exists in this process.
 *
 * The throw happened inside `bootRestoreTabs()` immediately before the
 * `tabsReady: true, rehydrating: false` setState that ends boot restoration
 * (`boot-restore-tabs.ts`), so it silently aborted on every single server
 * start: `tabsReady` never became true, and `rehydrating` never cleared --
 * which in turn made `session-store-persistence.ts`'s subscriber early-return
 * forever, so nothing was ever written back to disk. This test pins that the
 * function is safe to call with no `window` global at all (the real
 * environment it runs in), and that it restores geometry unclamped -- every
 * consumer (`FloatingPanel.tsx`, `useFileEditorPanel.ts`) already clamps to
 * its OWN real viewport on render, so clamping here was redundant even
 * before it started throwing.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useSessionStore } from '../store/sessionStore'
import { restoreGlobalGeometry } from './useTabRestoration-geometry'
import type { PersistedTabState } from '@ion/shared/types'

describe('restoreGlobalGeometry', () => {
  beforeEach(() => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined')
  })

  it('does not throw with no window global present', () => {
    const saved = {
      editorGeometry: { x: 10, y: 20, w: 500, h: 400 },
      planGeometry: { x: 30, y: 40, w: 300, h: 200 },
      agentDetailGeometry: { x: 50, y: 60, w: 320, h: 220 },
    } as unknown as PersistedTabState
    expect(() => restoreGlobalGeometry(saved)).not.toThrow()
  })

  it('restores each geometry unclamped -- the client clamps to its own viewport', () => {
    const saved = {
      editorGeometry: { x: 10, y: 20, w: 500, h: 400 },
      planGeometry: { x: 30, y: 40, w: 300, h: 200 },
      agentDetailGeometry: { x: 50, y: 60, w: 320, h: 220 },
    } as unknown as PersistedTabState
    restoreGlobalGeometry(saved)
    const state = useSessionStore.getState()
    expect(state.editorGeometry).toEqual(saved.editorGeometry)
    expect(state.planGeometry).toEqual(saved.planGeometry)
    expect(state.agentDetailGeometry).toEqual(saved.agentDetailGeometry)
  })

  it('leaves existing geometry alone when a field is absent from the saved state', () => {
    const before = useSessionStore.getState().editorGeometry
    restoreGlobalGeometry({} as PersistedTabState)
    expect(useSessionStore.getState().editorGeometry).toEqual(before)
  })
})
