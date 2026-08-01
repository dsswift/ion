/**
 * useBenchReorder — drag an enrolled row to change the bench's merge order.
 *
 * ── Why the target index is clamped, not rejected ───────────────────────────
 * A bench merges its members in array order, and only ENROLLED rows have a
 * position in that array. The list they live in also holds unenrolled rows
 * below them, so a drag that travels past the last enrolled row has no valid
 * destination. Clamping to the enrolled range means such a drag reads as "put it
 * last" -- which is what the operator saw when they let go -- rather than
 * silently unenrolling the row or doing nothing.
 *
 * That clamp is the whole safety property: a reorder gesture must never be able
 * to change MEMBERSHIP. Dropping out of the group is the one outcome that would
 * be destructive and un-obvious.
 *
 * ── Why HTML5 drag events ───────────────────────────────────────────────────
 * The rows are ordinary flex children in a scrolling column, not absolutely
 * positioned canvas items, so the native drag protocol gives auto-scroll at the
 * container edges and a drag image for free. A mousemove implementation would
 * have to reimplement both.
 */
import { useCallback, useState } from 'react'
import { rDebug } from '../rendererLogger'

/**
 * Where a drag from `fromIndex` should land, given the drop target.
 *
 * Pure and exported so the index arithmetic is testable without a DOM. Returns
 * `null` when the move is a no-op, so the caller can skip a pointless store
 * write and the assembly it would trigger.
 */
export function resolveDropIndex(
  fromIndex: number,
  overIndex: number,
  enrolledCount: number,
): number | null {
  if (fromIndex < 0 || enrolledCount <= 1) return null
  // The enrolled group occupies [0, enrolledCount). Anything past it is an
  // unenrolled row, and the honest reading of that drop is "last in the bench".
  const clamped = Math.max(0, Math.min(enrolledCount - 1, overIndex))
  return clamped === fromIndex ? null : clamped
}

export interface UseBenchReorderResult {
  /** Index currently being dragged, or null. */
  draggingIndex: number | null
  /** Index the row would land at, for the drop-line indicator. */
  overIndex: number | null
  /** Props to spread onto an enrolled row. Empty for unenrolled rows. */
  rowHandlers(index: number, enrolled: boolean): {
    draggable?: boolean
    onDragStart?(e: React.DragEvent): void
    onDragOver?(e: React.DragEvent): void
    onDragEnd?(): void
    onDrop?(e: React.DragEvent): void
  }
}

export function useBenchReorder({
  enrolledCount,
  onReorder,
}: {
  enrolledCount: number
  onReorder(fromIndex: number, toIndex: number): void
}): UseBenchReorderResult {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const finish = useCallback(() => {
    setDraggingIndex(null)
    setOverIndex(null)
  }, [])

  const rowHandlers = useCallback((index: number, enrolled: boolean) => {
    // Unenrolled rows are not draggable AND not drop targets. They can still be
    // dragged OVER -- the clamp turns that into "last" -- but they never receive
    // a drop of their own, so a stray release cannot reorder anything.
    if (!enrolled) return {}

    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        // The row's own click opens a conversation; a drag must not also do
        // that when it ends over the same row.
        e.stopPropagation()
        // Required for Firefox/Chromium to start a drag at all. The payload is
        // unused -- the index lives in component state, which survives the drag.
        e.dataTransfer.setData('text/plain', String(index))
        e.dataTransfer.effectAllowed = 'move'
        setDraggingIndex(index)
        rDebug('bench.reorder', 'drag started', { from_index: index, enrolled_count: enrolledCount })
      },
      onDragOver: (e: React.DragEvent) => {
        if (draggingIndex === null) return
        // Without preventDefault the browser refuses the drop entirely.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (overIndex !== index) setOverIndex(index)
      },
      onDragEnd: finish,
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const from = draggingIndex
        finish()
        if (from === null) return
        const to = resolveDropIndex(from, index, enrolledCount)
        if (to === null) {
          rDebug('bench.reorder', 'drop was a no-op', { from_index: from, over_index: index })
          return
        }
        rDebug('bench.reorder', 'drop committed', { from_index: from, to_index: to })
        onReorder(from, to)
      },
    }
  }, [draggingIndex, overIndex, enrolledCount, finish, onReorder])

  return { draggingIndex, overIndex, rowHandlers }
}
