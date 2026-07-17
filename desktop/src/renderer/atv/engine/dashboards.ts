/**
 * dashboards — pure layout math for live wall dashboards: furniture with a
 * `dashboard` manifest flag renders real data inside its pixel bounds
 * (kanban board → dispatch task cards; TV/sparkline → $/min trend). The
 * draw pass lives in render-overlays.ts.
 */

export interface KanbanCard {
  col: 0 | 1 | 2 // queued | running | done
  x: number
  y: number
  w: number
  h: number
  color: string
}

const COL_COLORS = ['#8a8a80', '#ff8c3c', '#3ecf6e'] as const

/** Card layout for dispatch statuses inside a (w × h) pixel region. */
export function kanbanCards(statuses: readonly string[], w: number, h: number): KanbanCard[] {
  const colW = Math.floor(w / 3)
  const cardH = 2
  const gap = 1
  const perCol = Math.max(1, Math.floor(h / (cardH + gap)))
  const counts = [0, 0, 0]
  const cards: KanbanCard[] = []
  for (const status of statuses) {
    const col = status === 'running' ? 1 : status === 'done' || status === 'completed' ? 2 : 0
    const idx = counts[col]++
    if (idx >= perCol) continue // overflow: capped (counts still tallied)
    cards.push({
      col: col as 0 | 1 | 2,
      x: col * colW + 1,
      y: idx * (cardH + gap),
      w: colW - 2,
      h: cardH,
      color: COL_COLORS[col],
    })
  }
  return cards
}

/** Polyline points for a value series scaled into a (w × h) region. */
export function sparklinePoints(values: readonly number[], w: number, h: number): Array<{ x: number; y: number }> {
  if (values.length < 2) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return values.map((v, i) => ({
    x: (i / (values.length - 1)) * (w - 1),
    y: (h - 1) - ((v - min) / span) * (h - 1),
  }))
}
