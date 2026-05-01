import React, { useCallback, useRef, useState } from 'react'

// ─── Drag split hook ───

export function useGitDragSplit(
  containerRef: React.RefObject<HTMLDivElement | null>,
  splitRatio: number,
  setSplitRatio: (r: number) => void,
  fixedChrome: number,
) {
  const [isDragging, setIsDragging] = useState(false)
  const startRef = useRef({ y: 0, ratio: 0 })

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    startRef.current = { y: e.clientY, ratio: splitRatio }
    setIsDragging(true)

    const onMouseMove = (ev: MouseEvent) => {
      const container = containerRef.current
      if (!container) return
      const availableHeight = container.clientHeight - fixedChrome
      if (availableHeight <= 0) return
      const deltaY = ev.clientY - startRef.current.y
      const deltaRatio = deltaY / availableHeight
      const newRatio = Math.min(0.85, Math.max(0.15, startRef.current.ratio + deltaRatio))
      setSplitRatio(newRatio)
    }

    const onMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [splitRatio, containerRef, setSplitRatio, fixedChrome])

  return { onMouseDown, isDragging }
}
