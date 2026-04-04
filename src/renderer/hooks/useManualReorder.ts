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
}

interface UseManualReorderResult {
  onItemPointerDown: (key: string, e: React.PointerEvent) => void
  isDraggingRef: RefObject<boolean>
}

export function useManualReorder<T>(opts: UseManualReorderOpts<T>): UseManualReorderResult {
  const { items, keyFn, itemRefs, onReorder, axis = 'x', threshold = 8, gap = 4 } = opts
  const isDraggingRef = useRef(false)
  const stateRef = useRef<{
    dragKey: string
    originX: number
    originY: number
    clone: HTMLDivElement | null
    originalEl: HTMLDivElement | null
    dropIndex: number
    startIndex: number
    siblingRects: Array<{ key: string; el: HTMLDivElement; mid: number }>
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

        // Snapshot sibling midpoints
        const refs = itemRefs.current
        if (refs) {
          state.siblingRects = items
            .map((item) => {
              const k = keyFn(item)
              const sibEl = refs.get(k)
              if (!sibEl) return null
              const r = sibEl.getBoundingClientRect()
              const mid = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2
              return { key: k, el: sibEl, mid }
            })
            .filter((s): s is NonNullable<typeof s> => s !== null)
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
      }
    }

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)

      const state = stateRef.current
      if (!state) return

      // Clean up clone and sibling transforms
      if (state.clone) {
        state.clone.remove()
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
  }, [items, keyFn, itemRefs, onReorder, axis, threshold, gap])

  return { onItemPointerDown, isDraggingRef }
}
