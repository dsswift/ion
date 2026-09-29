// @vitest-environment jsdom
/**
 * StudioLeftSidebar — the dock-fallback effect must key off `onSelectView`
 * specifically, not the whole `props` object.
 *
 * ── The failure this pins ───────────────────────────────────────────────────
 * StudioShell passes onFocusCapture/onMouseDownCapture/onClose as fresh
 * inline closures every render, so `props` never has a stable identity. An
 * effect depending on `[isRepo, view, props]` re-fires on every unrelated
 * parent render, and since its own action (onSelectView -> patch -> a new
 * layout object) itself triggers a parent re-render, that is a live-fire
 * setup for React error #185 ("Maximum update depth exceeded") the moment
 * the fallback condition is true. This is what a browser Studio client hit
 * on every sidebar toggle.
 *
 * The fix narrows the dependency to `props.onSelectView`. This test pins
 * that a fresh, unrelated prop identity on every render does not re-trigger
 * the effect.
 */

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { StudioLayout } from '@ion/shared/types-studio'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (selector: (s: { activeTabId: string | null }) => unknown) =>
    selector({ activeTabId: 'tab-1' }),
}))

vi.mock('../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../hooks/useActiveGitRepo', () => ({
  // Not a repo: this is the branch that drives the dock back to Explorer
  // whenever the persisted view is "git".
  useActiveGitRepo: () => ({ isRepo: false }),
}))

vi.mock('../shortcuts/useShortcutHints', () => ({
  useShortcutHint: () => null,
}))

vi.mock('./inbox/InboxSidebar', () => ({ InboxSidebar: () => React.createElement('div') }))
vi.mock('../components/FileExplorer', () => ({ FileExplorer: () => React.createElement('div') }))
vi.mock('../components/GitPanel', () => ({ GitPanel: () => React.createElement('div') }))
vi.mock('../components/WorkspaceStatusIndicator', () => ({ WorkspaceStatusIndicator: () => React.createElement('div') }))
vi.mock('../components/OpenSettingsButton', () => ({ OpenSettingsButton: () => React.createElement('div') }))
vi.mock('../shortcuts/ShortcutHint', () => ({ ShortcutHint: () => React.createElement('div') }))

import { StudioLeftSidebar } from './StudioLeftSidebar'

let container: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
})

function layoutWithView(view: StudioLayout['leftSidebarView']): StudioLayout {
  return {
    leftSidebarVisible: true,
    leftSidebarWidth: 440,
    leftSidebarView: view,
    terminalVisible: false,
    terminalHeight: 240,
    surfaceVisible: false,
    surfaceWidth: 420,
  } as unknown as StudioLayout
}

describe('StudioLeftSidebar dock-fallback effect', () => {
  it('does not re-fire onSelectView on unrelated re-renders with fresh handler identities', async () => {
    const onSelectView = vi.fn()
    const root = createRoot(container)

    // Mirrors StudioShell: onSelectView is stable, but onFocusCapture /
    // onMouseDownCapture / onClose are fresh closures every render -- exactly
    // the shape that made `props` itself unstable.
    const renderOnce = (): void => {
      root.render(
        React.createElement(StudioLeftSidebar, {
          layout: layoutWithView('git'),
          onSelectView,
          onFocusCapture: () => {},
          onMouseDownCapture: () => {},
          onClose: () => {},
        }),
      )
    }

    await act(async () => {
      renderOnce()
      await Promise.resolve()
    })
    expect(onSelectView).toHaveBeenCalledTimes(1)
    expect(onSelectView).toHaveBeenCalledWith('explorer')

    // Three more renders, each with brand-new inline handler closures, none
    // of which change isRepo or view.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        renderOnce()
        await Promise.resolve()
      })
    }

    expect(onSelectView).toHaveBeenCalledTimes(1)

    await act(async () => { root.unmount() })
  })
})
