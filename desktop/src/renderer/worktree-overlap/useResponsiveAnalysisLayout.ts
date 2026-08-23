import { useLayoutEffect, useState } from 'react'
import type React from 'react'

export const TWO_COLUMN_MIN_WIDTH = 860

export type AnalysisLayout = 'one-column' | 'two-column'

export function useResponsiveAnalysisLayout(
  containerRef: React.RefObject<HTMLElement | null>,
): AnalysisLayout {
  const [layout, setLayout] = useState<AnalysisLayout>('one-column')

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const update = (width: number): void => {
      setLayout(width >= TWO_COLUMN_MIN_WIDTH ? 'two-column' : 'one-column')
    }
    update(container.getBoundingClientRect().width)

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find(({ target }) => target === container)
      update(entry?.contentRect.width ?? container.getBoundingClientRect().width)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])

  return layout
}
