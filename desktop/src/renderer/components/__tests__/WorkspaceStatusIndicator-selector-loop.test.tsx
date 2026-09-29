// @vitest-environment jsdom
/**
 * `WorkspaceStatusIndicator`'s terminal-activity lookup must derive from a
 * stable `terminalActivities` selector plus `useMemo`, not build a fresh
 * `Set` inside the zustand selector itself.
 *
 * Same failure as `SurfaceTabStrip-dirty-paths-loop.test.tsx`: a selector
 * that allocates a new object on every call never returns the same
 * reference twice. Zustand's `useStore` is `useSyncExternalStore`-based, so
 * a snapshot that never stabilizes makes React re-render forever detecting
 * tearing -- "Maximum update depth exceeded" (React error #185). This
 * crashed the workspace status indicator on mount (observed live: a fresh
 * Studio session in a browser client crashed with this error the instant
 * the indicator rendered).
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '@ion/server/store/sessionStore'

vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../PopoverLayer', () => ({ usePopoverLayer: () => null }))
vi.mock('../../stores/questions-store', () => ({ useQuestionsStore: () => new Map() }))

import { WorkspaceStatusIndicator } from '../WorkspaceStatusIndicator'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  useSessionStore.setState({ tabs: [], terminalActivities: new Map(), conversationPanes: new Map(), activeTabId: null } as never)
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

describe('WorkspaceStatusIndicator terminal-activity selector', () => {
  it('mounts and re-renders on an unrelated sessionStore update without exceeding the update depth', () => {
    act(() => {
      root = createRoot(container)
      root.render(React.createElement(WorkspaceStatusIndicator))
    })
    expect(() => {
      act(() => {
        useSessionStore.setState({ tabs: [], terminalActivities: new Map(), conversationPanes: new Map(), activeTabId: null } as never)
      })
    }).not.toThrow()
  })
})
