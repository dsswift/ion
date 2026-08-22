/**
 * useResizablePane — shared pointer-drag resize primitive for every Studio
 * layout seam (left sidebar, right surface, bottom terminal, dispatch split).
 *
 * ── Why not the existing resize hooks ──────────────────────────────────────
 * `useEdgeResize` solves `{x, y, w, h}` for position:fixed floating panels
 * (8 directions, mouse listeners on document). `usePanelVerticalResize` is
 * bottom-anchored-panel-specific and persists per drag frame. Studio seams
 * need a third shape: one axis, one edge, pointer capture on the handle (no
 * document listeners), rAF-coalesced live resize, and persistence exactly
 * once on release — one disk write per gesture through the settings funnel.
 *
 * Design (t3-informed, Ion idioms):
 *   - Pointer capture on the handle element — no document-level listeners,
 *     no leak when the handle unmounts mid-drag.
 *   - Live resize is rAF-coalesced: at most one onResize per frame no matter
 *     how fast pointermove fires.
 *   - Persistence is commit-on-release: onCommit fires exactly once, on
 *     pointerup/pointercancel, with the final clamped size. Callers wire
 *     onResize to React state and onCommit to the settings funnel so a drag
 *     costs one disk write, not hundreds.
 *   - `edge` names which edge of the PANE the handle sits on: a left dock is
 *     resized by its 'end' (right) edge — dragging right grows it; a right
 *     surface panel is resized by its 'start' (left) edge — dragging left
 *     grows it. The hook owns the sign so callers never re-derive it.
 *
 * Ratio seams (e.g. the dispatch split): the caller measures its container
 * at drag start and converts px → ratio inside onCommit; the hook stays in
 * px space.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

export interface ResizablePaneOptions {
  /** 'x' = horizontal drag changes width; 'y' = vertical drag changes height. */
  axis: 'x' | 'y'
  /**
   * Which edge of the pane the handle occupies. 'start' = left/top edge
   * (pane grows when the pointer moves toward start, i.e. delta is
   * inverted); 'end' = right/bottom edge (pane grows with the pointer).
   */
  edge: 'start' | 'end'
  /** Clamp bounds (inclusive), in px. */
  min: number
  max: number
  /** Current committed size, in px. Captured at drag start. */
  size: number
  /** Live per-frame size during the drag (rAF-coalesced). React state only. */
  onResize: (size: number) => void
  /** Final size, exactly once per gesture, on release. Persist here. */
  onCommit: (size: number) => void
  /** Disable the handle (e.g. pane collapsed). */
  disabled?: boolean
}

export interface ResizablePaneResult {
  /** Spread onto the handle element. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
    style: React.CSSProperties
  }
  /** True while a drag gesture is active (callers style the handle). */
  dragging: boolean
}

export function useResizablePane(opts: ResizablePaneOptions): ResizablePaneResult {
  const [dragging, setDragging] = useState(false)

  // The pointer listeners are registered per-gesture on the handle element;
  // refs keep them reading fresh options without re-registration.
  const optsRef = useRef(opts)
  optsRef.current = opts

  const gestureRef = useRef<{
    pointerId: number
    startCoord: number
    startSize: number
    lastSize: number
    raf: number
    pendingSize: number | null
    element: HTMLElement
  } | null>(null)

  const endGesture = useCallback((commit: boolean) => {
    const g = gestureRef.current
    if (!g) return
    gestureRef.current = null
    if (g.raf) cancelAnimationFrame(g.raf)
    try {
      g.element.releasePointerCapture(g.pointerId)
    } catch {
      // silent-ok: capture already released by the browser (element detached)
    }
    setDragging(false)
    if (commit) optsRef.current.onCommit(g.pendingSize ?? g.lastSize)
  }, [])

  // Unmount mid-drag: cancel the frame and drop the gesture without
  // committing (the pane is gone; a write now would race its replacement).
  useEffect(() => {
    return () => {
      const g = gestureRef.current
      if (g?.raf) cancelAnimationFrame(g.raf)
      gestureRef.current = null
    }
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const o = optsRef.current
      if (o.disabled || e.button !== 0 || gestureRef.current) return
      const element = e.currentTarget
      element.setPointerCapture(e.pointerId)
      const startCoord = o.axis === 'x' ? e.clientX : e.clientY
      gestureRef.current = {
        pointerId: e.pointerId,
        startCoord,
        startSize: Math.min(o.max, Math.max(o.min, o.size)),
        lastSize: Math.min(o.max, Math.max(o.min, o.size)),
        raf: 0,
        pendingSize: null,
        element,
      }
      setDragging(true)

      const onMove = (ev: PointerEvent): void => {
        const g = gestureRef.current
        if (!g || ev.pointerId !== g.pointerId) return
        const oo = optsRef.current
        const coord = oo.axis === 'x' ? ev.clientX : ev.clientY
        // 'end' edge: pane grows with the pointer. 'start' edge: inverted.
        const delta = oo.edge === 'end' ? coord - g.startCoord : g.startCoord - coord
        const next = Math.min(oo.max, Math.max(oo.min, g.startSize + delta))
        g.pendingSize = next
        if (!g.raf) {
          g.raf = requestAnimationFrame(() => {
            const gg = gestureRef.current
            if (!gg) return
            gg.raf = 0
            if (gg.pendingSize !== null && gg.pendingSize !== gg.lastSize) {
              gg.lastSize = gg.pendingSize
              optsRef.current.onResize(gg.pendingSize)
            }
          })
        }
      }
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== gestureRef.current?.pointerId) return
        element.removeEventListener('pointermove', onMove)
        element.removeEventListener('pointerup', onUp)
        element.removeEventListener('pointercancel', onCancel)
        endGesture(true)
      }
      const onCancel = (ev: PointerEvent): void => {
        if (ev.pointerId !== gestureRef.current?.pointerId) return
        element.removeEventListener('pointermove', onMove)
        element.removeEventListener('pointerup', onUp)
        element.removeEventListener('pointercancel', onCancel)
        // Cancel still commits: the user's last seen geometry is the truth
        // (matching pointerup) — reverting on cancel would visibly snap back.
        endGesture(true)
      }
      // Listeners live on the capturing element, so they follow the capture
      // and vanish with the element — never document-level.
      element.addEventListener('pointermove', onMove)
      element.addEventListener('pointerup', onUp)
      element.addEventListener('pointercancel', onCancel)
    },
    [endGesture]
  )

  const cursor = opts.axis === 'x' ? 'col-resize' : 'row-resize'
  return {
    handleProps: {
      onPointerDown,
      style: {
        cursor: opts.disabled ? 'default' : cursor,
        touchAction: 'none',
        userSelect: 'none',
      },
    },
    dragging,
  }
}
