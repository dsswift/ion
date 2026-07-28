/**
 * Sash drag for the git panel's proportional panes.
 *
 * Replaces `useGitDragSplit`, which drove a single `splitRatio` scalar between
 * Changes and Graph and could not express a boundary between any other pair.
 *
 * ── What this does differently ──────────────────────────────────────────────
 * The old hook converted a cursor delta into a ratio delta directly, which only
 * works when exactly two things are being divided. Here the delta is handed to
 * `resizePanes`, the port of `SplitView.resize`, which walks outward from the
 * sash and returns a full proportions map. So a drag can redistribute across
 * three or four panes when the immediate neighbour is already at its minimum,
 * and every pane is resizable rather than just two.
 *
 * ── Why the drag is tracked from an absolute origin ─────────────────────────
 * Each mousemove computes the delta from where the drag STARTED against the
 * proportions captured at that moment, rather than accumulating frame to frame.
 * Accumulating would compound the clamping error at every pane minimum: once a
 * neighbour pins, an incremental model keeps feeding it deltas it cannot use
 * and the cursor drifts away from the sash. Recomputing from the origin keeps
 * the sash under the pointer.
 */
import React, { useCallback, useRef, useState } from 'react'
import { resizePanes, type PaneLayoutInput, type PaneProportions } from '../components/git/paneLayout'

export interface UsePaneSashResult {
  /** Attach to each sash element's `onMouseDown`, bound to its index. */
  onSashMouseDown: (sashIndex: number, e: React.MouseEvent) => void
  /** True while a drag is in flight, for the cursor override and hover styling. */
  isDragging: boolean
}

/**
 * @param getInput  Reads the CURRENT layout input. A getter rather than a value
 *                  so the move handler always sees live pane state; capturing
 *                  the object would freeze the expanded/collapsed set for the
 *                  duration of the drag.
 * @param onCommit  Receives the new proportions on every move. Persisting on
 *                  each frame (rather than on mouseup) is what makes the panel
 *                  track the cursor, and the store write is cheap.
 */
export function usePaneSash(
  getInput: () => PaneLayoutInput,
  onCommit: (proportions: PaneProportions) => void,
): UsePaneSashResult {
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef<{ y: number; input: PaneLayoutInput; index: number } | null>(null)

  const onSashMouseDown = useCallback((sashIndex: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Snapshot the input at drag start: every move resolves against THIS
    // baseline, so the result is a pure function of total cursor travel.
    dragRef.current = { y: e.clientY, input: getInput(), index: sashIndex }
    setIsDragging(true)

    const onMouseMove = (ev: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      onCommit(resizePanes(drag.input, drag.index, ev.clientY - drag.y))
    }

    const onMouseUp = (): void => {
      dragRef.current = null
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [getInput, onCommit])

  return { onSashMouseDown, isDragging }
}
