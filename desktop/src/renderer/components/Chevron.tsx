import React from 'react'
import { CaretRight, type IconWeight } from '@phosphor-icons/react'
import { transitions } from '../theme-tokens'

interface ChevronProps {
  /** Expanded state — chevron points right when closed, down when open. */
  open: boolean
  size?: number
  color?: string
  weight?: IconWeight
}

/**
 * Standard expand/collapse chevron: one glyph rotated by state so the
 * transition animates, instead of swapping CaretRight/CaretDown icons
 * (which snaps with no motion). Use for every disclosure affordance —
 * tree rows, collapsible sections, tool cards.
 */
export function Chevron({ open, size = 10, color, weight = 'fill' }: ChevronProps): React.ReactElement {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        flexShrink: 0,
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: `transform ${transitions.fast}`,
      }}
    >
      <CaretRight size={size} color={color} weight={weight} />
    </span>
  )
}
