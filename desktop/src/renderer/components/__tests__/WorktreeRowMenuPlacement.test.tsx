// @vitest-environment jsdom
//
// WorktreeRowMenu — the menu must land inside the window.
//
// ── The defect ──────────────────────────────────────────────────────────────
// The menu rendered at the raw right-click point (`left: anchor.x, top:
// anchor.y`) with no measurement and no clamp. Right-clicking a worktree row
// near the bottom of the git panel — the common case, because the list grows
// downward and the newest worktrees sit at the end — opened a menu whose lower
// half was below the window edge, with Retire and Reveal unreachable.
//
// The fix routes placement through `useAnchoredPopover`, which measures the
// rendered menu and flips it above the click when opening downward would
// overflow. These tests drive the real component with a stubbed measurement
// and assert the rendered rect, so they fail if the positioning is removed.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Real Phosphor icons render cheaply in jsdom and cannot drift when the menu
// gains another icon. A hand-maintained replacement module made every placement
// test fail at render time whenever a new menu row or submenu trigger appeared.

vi.mock('framer-motion', () => ({
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) =>
      <div ref={ref} {...props}>{children}</div>),
  },
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

// `getState` as well as the selector call: the positioning hook reads the
// operator's UI zoom through `usePreferencesStore.getState()`.
vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (s: { worktreeCompletionStrategy: string }) => unknown) =>
      selector({ worktreeCompletionStrategy: 'merge-ff' }),
    { getState: () => ({ uiZoom: 1 }) },
  ),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { benchWorkspaces: Map<string, never>; tabs: unknown[]; workspaceOperationLedger: Map<string, never> }) => unknown) =>
      selector({ benchWorkspaces: new Map<string, never>(), tabs: [], workspaceOperationLedger: new Map<string, never>() }),
    { getState: () => ({}) },
  ),
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

import { PopoverLayerProvider } from '../PopoverLayer'
import { WorktreeRowMenu } from '../WorktreeRowMenu'
import { REPO, entry } from './worktree-row-menu-harness'

/** The menu's rendered size, as jsdom will report it. jsdom lays nothing out,
 *  so every rect is zero unless we say otherwise — and a zero-height menu can
 *  never overflow, which would make this test vacuous. */
const MENU_W = 190
const MENU_H = 300
const VIEW_W = 1440
const VIEW_H = 900
const MARGIN = 8

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

/**
 * Report a rect for the menu that reflects the `left`/`top` the component
 * actually set, plus the fixed size above. This is what turns a jsdom render
 * into a real placement assertion: the hook measures, we answer with the
 * component's own inline position, and the hook's correction is then visible
 * in the next render's style.
 */
function stubLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (this.dataset.testid !== 'worktree-row-menu') {
        return new DOMRect(0, 0, 0, 0)
      }
      const left = parseFloat(this.style.left || '0')
      const top = parseFloat(this.style.top || '0')
      return new DOMRect(left, top, MENU_W, MENU_H)
    },
  })
}

function menuEl(): HTMLElement {
  const el = container.ownerDocument.querySelector('[data-testid="worktree-row-menu"]')
  if (!el) throw new Error('menu did not render')
  return el as HTMLElement
}

/** The menu's placed rect, read back off the inline style the component set. */
function placed(): { left: number; top: number; right: number; bottom: number } {
  const el = menuEl()
  const left = parseFloat(el.style.left || '0')
  const top = parseFloat(el.style.top || '0')
  return { left, top, right: left + MENU_W, bottom: top + MENU_H }
}

function renderAt(anchor: { x: number; y: number }): void {
  act(() => {
    root.render(
      <PopoverLayerProvider>
        <WorktreeRowMenu
          entry={entry()}
          anchor={anchor}
          repoPath={REPO}
          onClose={() => {}}
          onRefresh={() => {}}
        />
      </PopoverLayerProvider>,
    )
  })
}

describe('WorktreeRowMenu — placement', () => {
  beforeEach(() => {
    stubLayout()
    window.innerWidth = VIEW_W
    window.innerHeight = VIEW_H
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('right-clicked near the bottom edge: the menu stays fully on-screen', () => {
    // 20px of headroom below the click — the reported case. Placing the menu
    // at the click point would put its bottom at 1180, far below the window.
    renderAt({ x: 300, y: VIEW_H - 20 })
    const rect = placed()
    expect(rect.top).toBeGreaterThanOrEqual(MARGIN)
    expect(rect.bottom).toBeLessThanOrEqual(VIEW_H - MARGIN)
  })

  it('right-clicked in the bottom-right corner: both axes stay on-screen', () => {
    renderAt({ x: VIEW_W - 10, y: VIEW_H - 5 })
    const rect = placed()
    expect(rect.left).toBeGreaterThanOrEqual(MARGIN)
    expect(rect.right).toBeLessThanOrEqual(VIEW_W - MARGIN)
    expect(rect.top).toBeGreaterThanOrEqual(MARGIN)
    expect(rect.bottom).toBeLessThanOrEqual(VIEW_H - MARGIN)
  })

  it('right-clicked with room below: opens at the click, not flipped', () => {
    // The clamp must not fire when it is not needed — a menu that always
    // flipped would be just as wrong, and this pins the natural placement.
    renderAt({ x: 300, y: 100 })
    const rect = placed()
    expect(rect.top).toBe(108) // anchor.y + the hook's 8px 'below' offset
    expect(rect.left).toBe(300)
  })

  it('is hidden until it has been measured, so it never paints mid-flip', () => {
    renderAt({ x: 300, y: VIEW_H - 20 })
    // By the time act() returns the layout effect has run and the menu is
    // placed, so it must be visible — `visibility: hidden` only covers the
    // pre-measurement frame.
    expect(menuEl().style.visibility).toBe('visible')
  })
})
