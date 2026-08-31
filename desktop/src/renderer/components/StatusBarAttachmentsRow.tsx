/**
 * The shared row primitive for the attachments popover.
 *
 * Extracted so the Charts section can live in its own file without either
 * copy of the row drifting from the other: hover, pressed, and focus behavior
 * are identical for a plan, a file, a resource, and a chart, and a user who
 * notices one row highlighting differently from its neighbour is looking at a
 * bug.
 */

import React from 'react'
import { useColors } from '../theme'
import { useInteractiveState } from '../hooks/useInteractiveState'

/**
 * One clickable row in the attachments popover (plan / file / resource / chart).
 *
 * A separate component so each row owns its own useInteractiveState hook
 * (rules-of-hooks: no hooks inside the section map loops). `hoverBg` keeps
 * each section's tint (plans green, files surface, resources purple-neutral);
 * pressed uses the standard surfacePressed layer.
 */
export function AttachmentRow({ colors, hoverBg, color, onClick, children }: {
  colors: ReturnType<typeof useColors>
  hoverBg: string
  color: string
  onClick: () => void
  children: React.ReactNode
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={onClick}
      {...handlers}
      className="flex items-center gap-2 w-full text-left ion-focusable"
      style={{
        padding: '4px 12px',
        fontSize: 11,
        color,
        cursor: 'pointer',
        background: pressed ? colors.surfacePressed : hover ? hoverBg : 'transparent',
        border: 'none',
      }}
    >
      {children}
    </button>
  )
}
