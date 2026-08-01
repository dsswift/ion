/**
 * usePanelVerticalResize — drag a bottom-anchored panel's top edge to grow it.
 *
 * ── Why not `useEdgeResize` ─────────────────────────────────────────────────
 * That hook solves `{x, y, w, h}` for `position: fixed` panels and clamps
 * height to `window.innerHeight` internally. These panels are bottom-anchored
 * INSIDE the content column, so their ceiling is
 * `winHeight - PANEL_BOTTOM_OFFSET - PANEL_TOP_RESERVE`, and they have no x/y to
 * solve. A vertical-only hook is the exactly-fitting mechanism, and it also
 * removes the duplicated height math from both panels.
 *
 * ── Persisted like any other preference ─────────────────────────────────────
 * The override lives in the preferences store (`gitPanelHeight` /
 * `fileExplorerHeight`) and rides ~/.ion/settings.json, so a sized panel
 * survives a restart. Null means "use the default". The render path re-clamps
 * against the live window height on every render (resolvePanelHeight), so a
 * height saved on a larger display degrades gracefully on a smaller one. The
 * disk write is debounced in the setter — this hook commits per drag frame.
 */
import React, { useCallback, useRef, useState } from 'react'
import { useWindowHeight } from './useWindowGeometry'
import { defaultPanelHeight, maxPanelHeight, resolvePanelHeight } from '../components/panelGeometry'
import { PanelResizeHandle } from '../components/PanelResizeHandle'
import { rDebug } from '../rendererLogger'

/**
 * Height after a drag of `dy` pixels from `startHeight`.
 *
 * `dy` is negative when the cursor moves UP, and up means taller because the
 * panel is anchored at its bottom. Pure and exported so the arithmetic is
 * testable without a DOM.
 */
export function resolveDragHeight(
  startHeight: number,
  dy: number,
  minHeight: number,
  maxHeight: number,
): number {
  return Math.min(maxHeight, Math.max(minHeight, startHeight - dy))
}

export interface UsePanelVerticalResizeResult {
  /** The height to render at, always derived and always within bounds. */
  height: number
  isResizing: boolean
  /** The top-edge grab strip. Returned so both panels get an identical one. */
  renderHandle(): React.JSX.Element
}

export function usePanelVerticalResize({
  panelId,
  expandedUI,
  override,
  onCommit,
}: {
  /** Log field and test id, e.g. `git-panel`. */
  panelId: string
  expandedUI: boolean
  override: number | null
  onCommit(height: number | null): void
}): UsePanelVerticalResizeResult {
  const winHeight = useWindowHeight()
  const [isResizing, setIsResizing] = useState(false)
  const dragRef = useRef<{ y: number; startHeight: number } | null>(null)

  const defaultHeight = defaultPanelHeight(expandedUI)
  const height = resolvePanelHeight(override, defaultHeight, winHeight)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Snapshot at drag start so every move resolves against THIS baseline and
    // the result is a pure function of total cursor travel -- the same
    // convention usePaneSash uses.
    dragRef.current = { y: e.clientY, startHeight: height }
    setIsResizing(true)
    rDebug('panel-resize', 'drag started', { panel_id: panelId, start_height: height })

    const min = defaultPanelHeight(expandedUI)
    const max = maxPanelHeight(window.innerHeight, min)

    const onMouseMove = (ev: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      // Commit on every move: the store write is cheap and it keeps the edge
      // under the cursor rather than snapping on release.
      onCommit(resolveDragHeight(drag.startHeight, ev.clientY - drag.y, min, max))
    }

    const onMouseUp = (): void => {
      const drag = dragRef.current
      dragRef.current = null
      setIsResizing(false)
      if (drag) {
        rDebug('panel-resize', 'drag committed', {
          panel_id: panelId, start_height: drag.startHeight,
        })
      }
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
    }

    document.body.style.cursor = 'row-resize'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [expandedUI, height, onCommit, panelId])

  const renderHandle = useCallback((): React.JSX.Element => (
    <PanelResizeHandle
      isResizing={isResizing}
      onMouseDown={onMouseDown}
      testId={`${panelId}-resize-handle`}
    />
  ), [isResizing, onMouseDown, panelId])

  return { height, isResizing, renderHandle }
}
