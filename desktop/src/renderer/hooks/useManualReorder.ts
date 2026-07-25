import { useRef, useCallback } from 'react'
import type { RefObject } from 'react'

interface UseManualReorderOpts<T> {
  items: T[]
  keyFn: (item: T) => string
  itemRefs: RefObject<Map<string, HTMLDivElement>>
  onReorder: (reordered: T[]) => void
  axis?: 'x' | 'y'
  threshold?: number
  gap?: number
  /** When set, a 2px insertion bar of this color is rendered at the current
   * drop index while a drag is in flight (the standard "drag insertion"
   * state from the desktop style guide). Pass a token value — e.g.
   * `colors.dragInsertIndicator` — never a literal. The bar lives alongside
   * the drag clone as an imperative DOM node: this hook renders drag
   * feedback outside the React tree by design, so the indicator follows the
   * same mechanism instead of forcing per-move re-renders. */
  insertIndicatorColor?: string
}

interface UseManualReorderResult {
  onItemPointerDown: (key: string, e: React.PointerEvent) => void
  isDraggingRef: RefObject<boolean>
}

export function useManualReorder<T>(opts: UseManualReorderOpts<T>): UseManualReorderResult {
  const { items, keyFn, itemRefs, onReorder, axis = 'x', threshold = 8, gap = 4, insertIndicatorColor } = opts
  const isDraggingRef = useRef(false)
  const stateRef = useRef<{
    dragKey: string
    originX: number
    originY: number
    clone: HTMLDivElement | null
    originalEl: HTMLDivElement | null
    indicator: HTMLDivElement | null
    dropIndex: number
    startIndex: number
    siblingRects: Array<{ key: string; el: HTMLDivElement; mid: number; rect: DOMRect }>
  } | null>(null)

  const onItemPointerDown = useCallback((key: string, e: React.PointerEvent) => {
    if (e.button !== 0) return

    const el = itemRefs.current?.get(key)
    if (!el) return

    const originX = e.clientX
    const originY = e.clientY
    const startIndex = items.findIndex((item) => keyFn(item) === key)
    if (startIndex === -1) return

    stateRef.current = {
      dragKey: key,
      originX,
      originY,
      clone: null,
      originalEl: el,
      indicator: null,
      dropIndex: startIndex,
      startIndex,
      siblingRects: [],
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      const state = stateRef.current
      if (!state) return

      const dx = moveEvent.clientX - state.originX
      const dy = moveEvent.clientY - state.originY
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (!isDraggingRef.current && dist >= threshold) {
        // Start drag: create clone, snapshot sibling rects
        isDraggingRef.current = true
        const rect = state.originalEl!.getBoundingClientRect()
        const clone = state.originalEl!.cloneNode(true) as HTMLDivElement
        clone.style.position = 'fixed'
        clone.style.left = `${rect.left}px`
        clone.style.top = `${rect.top}px`
        clone.style.width = `${rect.width}px`
        clone.style.height = `${rect.height}px`
        clone.style.zIndex = '99999'
        clone.style.pointerEvents = 'none'
        clone.style.opacity = '0.85'
        clone.style.transition = 'none'
        document.body.appendChild(clone)
        state.clone = clone
        state.originalEl!.style.opacity = '0'

        // Snapshot sibling midpoints (and full rects, for the insertion bar)
        const refs = itemRefs.current
        if (refs) {
          state.siblingRects = items
            .map((item) => {
              const k = keyFn(item)
              const sibEl = refs.get(k)
              if (!sibEl) return null
              const r = sibEl.getBoundingClientRect()
              const mid = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2
              return { key: k, el: sibEl, mid, rect: r }
            })
            .filter((s): s is NonNullable<typeof s> => s !== null)
        }

        // Drag-insertion indicator: a fixed 2px bar positioned at the drop
        // index on every move (below). Only created when the consumer opted
        // in with a token color.
        if (insertIndicatorColor) {
          const bar = document.createElement('div')
          bar.style.position = 'fixed'
          bar.style.zIndex = '99998'
          bar.style.pointerEvents = 'none'
          bar.style.background = insertIndicatorColor
          bar.style.borderRadius = '1px'
          if (axis === 'x') {
            bar.style.width = '2px'
            bar.style.height = `${rect.height}px`
            bar.style.top = `${rect.top}px`
          } else {
            bar.style.height = '2px'
            bar.style.width = `${rect.width}px`
            bar.style.left = `${rect.left}px`
          }
          document.body.appendChild(bar)
          state.indicator = bar
        }
      }

      if (isDraggingRef.current && state.clone) {
        // Move clone
        const rect = state.originalEl!.getBoundingClientRect()
        if (axis === 'x') {
          state.clone.style.left = `${rect.left + dx}px`
        } else {
          state.clone.style.top = `${rect.top + dy}px`
        }

        // Compute drop index from cursor position relative to sibling midpoints
        const cursor = axis === 'x' ? moveEvent.clientX : moveEvent.clientY
        let newDropIndex = state.startIndex
        for (let i = 0; i < state.siblingRects.length; i++) {
          if (cursor > state.siblingRects[i].mid) {
            newDropIndex = i
          }
        }
        // If cursor is before the first midpoint, drop at 0
        if (state.siblingRects.length > 0 && cursor < state.siblingRects[0].mid) {
          newDropIndex = 0
        }
        state.dropIndex = newDropIndex

        // Apply translateX/Y shifts to siblings
        const draggedRect = state.siblingRects.find((s) => s.key === state.dragKey)
        if (!draggedRect) return
        const dragWidth = state.originalEl!.getBoundingClientRect().width + gap

        for (const sib of state.siblingRects) {
          if (sib.key === state.dragKey) continue
          const sibIdx = items.findIndex((item) => keyFn(item) === sib.key)
          let shift = 0
          if (state.startIndex < state.dropIndex) {
            // Dragging right: items between start+1..drop shift left
            if (sibIdx > state.startIndex && sibIdx <= state.dropIndex) {
              shift = -dragWidth
            }
          } else if (state.startIndex > state.dropIndex) {
            // Dragging left: items between drop..start-1 shift right
            if (sibIdx >= state.dropIndex && sibIdx < state.startIndex) {
              shift = dragWidth
            }
          }
          const prop = axis === 'x' ? 'translateX' : 'translateY'
          sib.el.style.transition = 'transform 150ms ease'
          sib.el.style.transform = `${prop}(${shift}px)`
        }

        // Position the insertion bar at the drop slot. Geometry is derived
        // from the ORIGINAL (unshifted) rects snapshotted at drag start:
        //   - drop at own slot        → the dragged item's original leading edge
        //   - drop after start (d>s)  → the gap opens where item d's trailing
        //                               edge lands after the leftward shift
        //   - drop before start (d<s) → the gap opens at item d's original
        //                               leading edge (d shifts away from it)
        if (state.indicator) {
          const dropItem = items[state.dropIndex]
          const dropRect = dropItem
            ? state.siblingRects.find((s) => s.key === keyFn(dropItem))?.rect
            : undefined
          if (dropRect) {
            const d = state.dropIndex
            const start = state.startIndex
            if (axis === 'x') {
              const pos = d > start ? dropRect.right + gap - dragWidth : dropRect.left
              state.indicator.style.left = `${pos - 1}px`
            } else {
              const pos = d > start ? dropRect.bottom + gap - dragWidth : dropRect.top
              state.indicator.style.top = `${pos - 1}px`
            }
          }
        }
      }
    }

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)

      const state = stateRef.current
      if (!state) return

      // Clean up clone, insertion bar, and sibling transforms
      if (state.clone) {
        state.clone.remove()
      }
      if (state.indicator) {
        state.indicator.remove()
      }
      if (state.originalEl) {
        state.originalEl.style.opacity = ''
      }
      for (const sib of state.siblingRects) {
        sib.el.style.transition = ''
        sib.el.style.transform = ''
      }

      // If we actually dragged and the index changed, reorder
      if (isDraggingRef.current && state.dropIndex !== state.startIndex) {
        const reordered = [...items]
        const [moved] = reordered.splice(state.startIndex, 1)
        reordered.splice(state.dropIndex, 0, moved)
        onReorder(reordered)
      }

      stateRef.current = null
      // Defer isDragging reset so click handlers can still check it
      requestAnimationFrame(() => {
        isDraggingRef.current = false
      })
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }, [items, keyFn, itemRefs, onReorder, axis, threshold, gap, insertIndicatorColor])

  return { onItemPointerDown, isDraggingRef }
}
