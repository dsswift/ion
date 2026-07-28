import React from 'react'
import { useColors } from '../../theme'
import { SASH_SIZE } from './paneLayout'

/**
 * A draggable boundary between two expanded panes.
 *
 * Defined at module scope, NOT inside GitPanel: a component declared during
 * render is a new type on every render, so React unmounts and remounts the
 * entire subtree — which for this panel means losing scroll position and any
 * in-progress interaction on every state change.
 *
 * Renders nothing for index -1, which is what `sashAfter` returns when the pane
 * below is collapsed or hidden — there is nothing to redistribute across a
 * collapsed pane, so no handle should suggest otherwise.
 */
export function Sash({ index, isDragging, colors, onSashMouseDown }: {
  index: number
  isDragging: boolean
  colors: ReturnType<typeof useColors>
  onSashMouseDown: (index: number, e: React.MouseEvent) => void
}): React.JSX.Element | null {
  if (index < 0) return null
  return (
    <div
      data-ion-ui
      data-testid={`git-panel-sash-${index}`}
      onMouseDown={(e) => onSashMouseDown(index, e)}
      style={{
        height: SASH_SIZE,
        flexShrink: 0,
        cursor: 'row-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: isDragging ? colors.surfaceHover : 'transparent',
        transition: isDragging ? 'none' : 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!isDragging) (e.currentTarget as HTMLElement).style.background = colors.surfaceHover
      }}
      onMouseLeave={(e) => {
        if (!isDragging) (e.currentTarget as HTMLElement).style.background = 'transparent'
      }}
    >
      <div style={{
        width: 24,
        height: 2,
        borderRadius: 1,
        background: colors.textTertiary,
        opacity: isDragging ? 0.8 : 0.4,
      }} />
    </div>
  )
}
