/**
 * Decides whether the composer's control row has room for its pickers laid out
 * in full, or must fold them into one menu.
 *
 * The decision is measured, never guessed: the row reports the natural width
 * its expanded left cluster needs, and the hook compares that with the width
 * the row actually has. A hysteresis gap stops the row flickering between the
 * two layouts while a panel divider is dragged across the threshold.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Extra room (CSS px) the row must gain before it expands again. */
export const COMPOSER_ROW_EXPAND_HYSTERESIS = 24

/**
 * Sum of the row's flex gaps (CSS px). The row lays out five children —
 * leading, pickers, readouts, the growing spacer, trailing — separated by the
 * `gap-2` (8px) it carries, so four gaps sit between them.
 */
const ROW_GAPS = 32

/**
 * Pure decision. `required` is the width the expanded layout needs (left
 * cluster + right cluster + gap); `available` is the row's width.
 */
export function resolveComposerRowCollapsed(prevCollapsed: boolean, available: number, required: number): boolean {
  if (available <= 0 || required <= 0) return prevCollapsed
  if (prevCollapsed) return available < required + COMPOSER_ROW_EXPAND_HYSTERESIS
  return available < required
}

export interface ComposerRowLayout {
  rowRef: React.RefObject<HTMLDivElement | null>
  /** Wraps the pickers while they are expanded; its width is the memory of
   *  what the expanded layout needs once the row has collapsed. */
  expandedRef: React.RefObject<HTMLDivElement | null>
  /** The always-present buttons left of the pickers (`+`, Quick Tools). */
  leadingRef: React.RefObject<HTMLDivElement | null>
  /** The readouts right of the pickers (attachments, context). */
  readoutsRef: React.RefObject<HTMLDivElement | null>
  /** The right-hand cluster (run activity, voice, stop, send). */
  trailingRef: React.RefObject<HTMLDivElement | null>
  collapsed: boolean
}

export function useComposerRowLayout(): ComposerRowLayout {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const expandedRef = useRef<HTMLDivElement | null>(null)
  const leadingRef = useRef<HTMLDivElement | null>(null)
  const readoutsRef = useRef<HTMLDivElement | null>(null)
  const trailingRef = useRef<HTMLDivElement | null>(null)
  const expandedWidthRef = useRef(0)
  const [collapsed, setCollapsed] = useState(false)

  const measure = useCallback(() => {
    const row = rowRef.current
    if (!row) return
    // Only an expanded row can report what expanded needs; keep the last value
    // while collapsed.
    if (expandedRef.current) expandedWidthRef.current = expandedRef.current.scrollWidth
    // Every cluster that does not fold counts toward what the expanded layout
    // needs. Leaving one out understates `required`, and the row then claims
    // it has room for a layout that overflows.
    const fixed = (leadingRef.current?.scrollWidth ?? 0)
      + (readoutsRef.current?.scrollWidth ?? 0)
      + (trailingRef.current?.scrollWidth ?? 0)
    const required = expandedWidthRef.current + fixed + ROW_GAPS
    setCollapsed((prev) => resolveComposerRowCollapsed(prev, row.clientWidth, required))
  }, [])

  useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    if (expandedRef.current) observer.observe(expandedRef.current)
    measure()
    return () => observer.disconnect()
  }, [measure, collapsed])

  return { rowRef, expandedRef, leadingRef, readoutsRef, trailingRef, collapsed }
}
