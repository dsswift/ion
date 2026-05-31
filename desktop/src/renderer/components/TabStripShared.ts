import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Diamond, Square, StarFour, Triangle, Heart, Hexagon, Lightning, Terminal } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import type { useColors } from '../theme'
import type { TabState } from '../../shared/types'
import { computeAnchoredPosition } from './tabstrip-anchored-position'
export { computeAnchoredPosition } from './tabstrip-anchored-position'
export type { AnchoredPositionInput } from './tabstrip-anchored-position'

/** Pill background-color presets shown in the color picker. `null` means "use theme default". */
export const PILL_COLOR_PRESETS = [
  { color: null, label: 'Default' },
  { color: '#f08c4a', label: 'Orange' },
  { color: '#4ece78', label: 'Green' },
  { color: '#ef5350', label: 'Red' },
  { color: '#42a5f5', label: 'Blue' },
  { color: '#b06de8', label: 'Purple' },
  { color: '#f5c842', label: 'Gold' },
] as const

/** Pill status-icon presets shown in the icon picker. `null` means "use the default dot". */
export const PILL_ICON_PRESETS = [
  { icon: null, label: 'Default' },
  { icon: 'diamond', label: 'Diamond' },
  { icon: 'square', label: 'Square' },
  { icon: 'star', label: 'Star' },
  { icon: 'triangle', label: 'Triangle' },
  { icon: 'heart', label: 'Heart' },
  { icon: 'hexagon', label: 'Hexagon' },
  { icon: 'lightning', label: 'Lightning' },
] as const

/** Maps the persisted `pillIcon` string to a Phosphor icon component. */
export const PILL_ICON_MAP: Record<string, React.ComponentType<any>> = {
  diamond: Diamond,
  square: Square,
  star: StarFour,
  triangle: Triangle,
  heart: Heart,
  hexagon: Hexagon,
  lightning: Lightning,
  Terminal,
}

/** Adjust viewport rect to zoomed coordinate space for fixed positioning.
 * getBoundingClientRect() returns viewport pixels, but position:fixed inside
 * a CSS-zoomed root interprets coordinates in the zoomed space. Dividing by
 * zoom cancels the double-scaling. */
export function zoomRect(rect: DOMRect): DOMRect {
  const z = usePreferencesStore.getState().uiZoom
  if (z === 1) return rect
  return new DOMRect(rect.x / z, rect.y / z, rect.width / z, rect.height / z)
}

/** Return viewport dimensions in zoom-adjusted coordinate space. */
export function zoomViewport(): { width: number; height: number } {
  const z = usePreferencesStore.getState().uiZoom
  return { width: window.innerWidth / z, height: window.innerHeight / z }
}

// ─── Anchored-popover positioning ─────────────────────────────────────
//
// The tab-strip context menus are portaled into a fixed-position layer
// (`PopoverLayer`) and pinned to an anchor near where the user
// right-clicked. The naive "open downward at the click point" math
// fails in two ways:
//
//   1. When the window is short and the menu is tall (e.g. a manual
//      tab-group with many target groups, a worktree-aware tab menu,
//      etc.) the bottom of the popup falls off-screen and items become
//      un-clickable.
//   2. Submenus depending on a parent-row anchor inherit the same
//      problem and can overflow to the right of a narrow window.
//
// `useAnchoredPopoverPosition` is the canonical positioning utility for
// every anchored popover in the tab strip. It measures the popover
// after mount (via `useLayoutEffect` so it runs before paint), then
// picks an on-screen position that prefers the natural anchor
// placement but flips/clamps when the menu would overflow the
// viewport. The decision math is factored out into
// `computeAnchoredPosition` so it can be unit-tested without a DOM.
//
// IMPORTANT: callers must pass any state that changes the rendered
// menu height (e.g. `showNewGroupInput`, an open child submenu) in the
// `deps` array so the hook re-measures and repositions after the menu
// grows or shrinks. Failing to do so causes the menu to stay anchored
// at its first-measured size and re-overflow when its content
// expands.

// `computeAnchoredPosition` and `AnchoredPositionInput` are
// re-exported from `tabstrip-anchored-position.ts` (see imports
// above). The math lives in its own file so it can be unit-tested
// in node without importing the React / theme / preferences chain
// (those touch `document` at module-load time).

/** Options accepted by `useAnchoredPopoverPosition`. */
export interface UseAnchoredPopoverPositionOpts {
  /** Vertical offset from the anchor when opening downward. Default 8 ('below') / 0 ('rightOf'). */
  offsetY?: number
  /** Horizontal offset between a submenu and its parent row's right edge. Default 8. */
  offsetX?: number
  /** Margin between the popover and the viewport edge. Default 8. */
  margin?: number
  /** Anchor strategy — see `AnchoredPositionInput.prefer`. Default 'below'. */
  prefer?: 'below' | 'rightOf'
  /** Parent row rect — required for clean left-flip when `prefer === 'rightOf'`. */
  parentRect?: { left: number; right: number; top: number; bottom: number }
  /** Extra dependencies that should trigger a re-measure (e.g. open submenu state, inline input toggles). */
  deps?: ReadonlyArray<unknown>
}

/** Result of the positioning hook. `ready` is false on the first
 *  render (before measurement); consumers should keep the popover
 *  `visibility: hidden` until ready to avoid a one-frame flash at the
 *  unmeasured anchor position. */
export interface UseAnchoredPopoverPositionResult {
  /** Attach to the popover root so the hook can measure its size. */
  ref: React.RefCallback<HTMLElement>
  /** On-screen left in zoom-adjusted coordinates. */
  left: number
  /** On-screen top in zoom-adjusted coordinates. */
  top: number
  /** True once the popover has been measured at least once. */
  ready: boolean
}

/**
 * Position an anchored popover on-screen, measuring its size after
 * mount so the placement adapts to actual rendered height (rather
 * than guessing from item count).
 *
 * Usage:
 *
 *   const pos = useAnchoredPopoverPosition(
 *     anchor,
 *     { prefer: 'below', deps: [moveSubmenu, showNewGroupInput] },
 *   )
 *   return <div
 *     ref={pos.ref}
 *     style={{
 *       position: 'fixed',
 *       left: pos.left,
 *       top: pos.top,
 *       visibility: pos.ready ? 'visible' : 'hidden',
 *       maxHeight: `calc(100vh - 16px)`,
 *       overflowY: 'auto',
 *     }}
 *   >…</div>
 *
 * The `deps` array must include any state that changes menu height
 * (open submenus, inline inputs); otherwise the menu sticks at its
 * first-measured size and re-overflows on expansion.
 */
export function useAnchoredPopoverPosition(
  anchor: { x: number; y: number },
  opts: UseAnchoredPopoverPositionOpts = {},
): UseAnchoredPopoverPositionResult {
  const prefer = opts.prefer ?? 'below'
  const offsetY = opts.offsetY ?? (prefer === 'below' ? 8 : 0)
  const offsetX = opts.offsetX ?? 8
  const margin = opts.margin ?? 8
  const parentRect = opts.parentRect
  const deps = opts.deps ?? []

  const elRef = useRef<HTMLElement | null>(null)
  // Seed with the natural anchor placement so the first paint (before
  // measurement) lands roughly where the user clicked. The popover is
  // rendered with `visibility: hidden` until `ready` flips true on
  // the same frame, so this default is mostly a fallback for
  // consumers that don't gate on `ready`.
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>(() => ({
    left: anchor.x,
    top: anchor.y + (prefer === 'below' ? offsetY : 0),
    ready: false,
  }))

  // Measure-and-place runs synchronously after every render that
  // could change the menu's size or anchor. `useLayoutEffect` runs
  // before the browser paints, so the re-render with the corrected
  // position is invisible to the user.
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    const rect = zoomRect(el.getBoundingClientRect())
    const viewport = zoomViewport()
    const next = computeAnchoredPosition({
      anchor,
      menu: { width: rect.width, height: rect.height },
      viewport,
      offsetY,
      offsetX,
      margin,
      prefer,
      parentRect,
    })
    setPos((prev) => {
      // Skip the state update when nothing meaningful changed so we
      // don't trigger an endless re-render loop (the layout effect
      // re-runs on every render that changes the deps, but its
      // measurement is stable once the menu is laid out).
      if (prev.ready && prev.left === next.left && prev.top === next.top) return prev
      return { left: next.left, top: next.top, ready: true }
    })
    // We intentionally include `anchor.x` / `anchor.y` rather than the
    // object identity so a parent that reconstructs `anchor` each
    // render doesn't cause a measurement storm. `parentRect` is
    // similarly destructured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    anchor.x,
    anchor.y,
    offsetY,
    offsetX,
    margin,
    prefer,
    parentRect?.left,
    parentRect?.right,
    parentRect?.top,
    parentRect?.bottom,
    ...deps,
  ])

  // Re-measure on viewport changes — a window resize can flip a
  // previously-fits-below menu into needing to flip up.
  useLayoutEffect(() => {
    const onResize = () => {
      const el = elRef.current
      if (!el) return
      const rect = zoomRect(el.getBoundingClientRect())
      const viewport = zoomViewport()
      const next = computeAnchoredPosition({
        anchor,
        menu: { width: rect.width, height: rect.height },
        viewport,
        offsetY,
        offsetX,
        margin,
        prefer,
        parentRect,
      })
      setPos({ left: next.left, top: next.top, ready: true })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.x, anchor.y, offsetY, offsetX, margin, prefer, parentRect?.left, parentRect?.right, parentRect?.top, parentRect?.bottom])

  const refCallback = useCallback<React.RefCallback<HTMLElement>>((node) => {
    elRef.current = node
  }, [])

  return { ref: refCallback, left: pos.left, top: pos.top, ready: pos.ready }
}

/** Decide whether a tab-creation event should use worktree mode. Holding Alt inverts the default. */
export const shouldUseWorktree = (altKey: boolean): boolean => {
  const gitOpsMode = usePreferencesStore.getState().gitOpsMode
  return altKey ? gitOpsMode !== 'worktree' : gitOpsMode === 'worktree'
}

/** On-demand uncommitted check for worktree tabs whose status isn't in the map yet. */
export function checkWorktreeUncommitted(tab: TabState | undefined): void {
  if (!tab?.worktree) return
  const { worktreeUncommittedMap, setWorktreeUncommitted } = useSessionStore.getState()
  if (worktreeUncommittedMap.has(tab.id)) return
  window.ion.gitChanges(tab.workingDirectory).then((result) => {
    setWorktreeUncommitted(tab.id, result.files.length > 0)
  }).catch(() => {})
}

/** Compact relative-time formatter for tab-pill subtitles. */
export function formatRelativeShort(ms: number): string {
  const d = Date.now() - ms
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  return `${Math.floor(d / 86_400_000)}d`
}

/** Tristate "waiting for the user" derived from queued permission denials. */
export type WaitingState = 'plan-ready' | 'question' | null

/** Derive the waiting state from a denial-tools array. Returns 'question'
 *  if any tool is AskUserQuestion, else 'plan-ready' if any is
 *  ExitPlanMode, else null. Shared by both CLI and engine paths. */
function waitingStateFromTools(
  tools: ReadonlyArray<{ toolName: string }> | undefined | null,
): WaitingState {
  if (!tools?.length) return null
  if (tools.some((t) => t.toolName === 'AskUserQuestion')) return 'question'
  if (tools.some((t) => t.toolName === 'ExitPlanMode')) return 'plan-ready'
  return null
}

/**
 * Derive the waiting state from a tab's pending denials.
 *
 * - CLI tabs: read from `tab.permissionDenied`.
 * - Engine tabs (`tab.isEngine === true`): fold across every engine
 *   instance under this tab in `state.enginePermissionDenied`, returning
 *   the worst-priority waiting state ('question' > 'plan-ready' > null).
 *
 * Engine sub-tabs (instances) are independent sub-conversations and
 * each may have its own pending question or plan card. Parent-pill
 * glow must surface "any sub-tab is blocked," so we walk the per-
 * instance map keyed by `${tabId}:${instanceId}`.
 */
export function getWaitingState(tab: TabState): WaitingState {
  if (tab.isEngine) {
    // Read the store directly. This is invoked from render callsites
    // that already subscribe to the parts of state that change the
    // map's identity (enginePermissionDenied / enginePanes), so this
    // is consistent at render time.
    const s = useSessionStore.getState()
    const pane = s.enginePanes.get(tab.id)
    if (!pane || pane.instances.length === 0) return null
    let hasPlanReady = false
    for (const inst of pane.instances) {
      const entry = s.enginePermissionDenied.get(`${tab.id}:${inst.id}`)
      const ws = waitingStateFromTools(entry?.tools)
      if (ws === 'question') return 'question'
      if (ws === 'plan-ready') hasPlanReady = true
    }
    return hasPlanReady ? 'plan-ready' : null
  }
  return waitingStateFromTools(tab.permissionDenied?.tools)
}

/** Same tristate logic as `getWaitingState`, but for a single engine
 *  instance identified by its compound `${tabId}:${instanceId}` key.
 *  Used by the engine sub-tab pill renderer to draw a per-instance
 *  status dot. */
export function getEngineInstanceWaitingState(key: string): WaitingState {
  const entry = useSessionStore.getState().enginePermissionDenied.get(key)
  return waitingStateFromTools(entry?.tools)
}

/** Status-dot color/pulse/glow derived from a tab's runtime state. Used by both single dots and stacked group dots. */
export function getTabStatusColor(
  tab: TabState,
  colors: ReturnType<typeof useColors>,
): { bg: string; pulse: boolean; glow: boolean; glowColor: string } {
  let bg = colors.statusIdle
  let pulse = false
  let glow = false
  let glowColor = colors.statusPermissionGlow

  const waitingState = getWaitingState(tab)

  if (tab.status === 'dead' || tab.status === 'failed') {
    bg = colors.statusError
  } else if (tab.permissionQueue.length > 0) {
    bg = colors.statusPermission; glow = true
  } else if (waitingState === 'plan-ready') {
    bg = colors.statusComplete; glow = true; glowColor = colors.tabGlowPlanReady
  } else if (waitingState === 'question') {
    bg = colors.infoText; glow = true; glowColor = colors.tabGlowQuestion
  } else if (tab.status === 'connecting' || tab.status === 'running') {
    bg = colors.statusRunning; pulse = true
  } else if (tab.bashExecuting) {
    bg = colors.statusBash; pulse = true; glow = true; glowColor = colors.statusBashGlow
  } else if (tab.hasUnread) {
    bg = colors.statusComplete
  }

  return { bg, pulse, glow, glowColor }
}
