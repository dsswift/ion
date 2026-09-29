// @vitest-environment jsdom
/**
 * `SurfaceTabStrip`'s dirty-file lookup must derive from a stable
 * `fileEditorStates` selector plus `useMemo`, not build a fresh `Set` inside
 * the zustand selector itself.
 *
 * ── The failure this pins ───────────────────────────────────────────────────
 * A selector that allocates a new object on every call never returns the
 * same reference twice. Zustand's `useStore` is built on
 * `useSyncExternalStore`, which re-invokes `getSnapshot` to check for
 * tearing after every render; a snapshot that never stabilizes makes React
 * conclude the store is still changing and re-render again, forever --
 * "Maximum update depth exceeded" (React error #185). This crashed the
 * Surface panel (the Studio shell's right-hand column) the moment it
 * mounted with any `fileEditorStates` content at all.
 *
 * The fix selects the raw `fileEditorStates` Map (a stable reference unless
 * it truly changes) and derives the dirty-paths Set in `useMemo`. This test
 * mounts the REAL `useSessionStore` and `useSurfaceStore` (real zustand,
 * real `useSyncExternalStore`) so the unfixed selector reproduces the actual
 * React crash, not a mocked approximation of it.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '@ion/server/store/sessionStore'

vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../components/git/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children),
}))
vi.mock('./SurfaceAddMenu', () => ({ SurfaceAddMenu: () => null }))
vi.mock('./SurfaceTabContextMenu', () => ({ SurfaceTabContextMenu: () => null }))
vi.mock('../../shortcuts/ShortcutHint', () => ({ ShortcutHint: () => null }))
vi.mock('../../shortcuts/useShortcutHints', () => ({ useRevealedShortcuts: () => new Map() }))

import { SurfaceTabStrip } from './SurfaceTabStrip'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  useSessionStore.setState({ fileEditorStates: new Map(), activeTabId: 'tab-1' } as never)
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

describe('SurfaceTabStrip dirty-paths selector', () => {
  it('mounts and re-renders on an unrelated sessionStore update without exceeding the update depth', () => {
    act(() => {
      root = createRoot(container)
      root.render(React.createElement(SurfaceTabStrip))
    })
    // Any real fileEditorStates content is what put an entry through the
    // dirty-lookup selector on the pre-fix code; a bare re-render with a
    // fresh (but unrelated) fileEditorStates reference is what a real file
    // open/close does.
    expect(() => {
      act(() => {
        useSessionStore.setState({ fileEditorStates: new Map(), activeTabId: 'tab-1' } as never)
      })
    }).not.toThrow()
  })
})
