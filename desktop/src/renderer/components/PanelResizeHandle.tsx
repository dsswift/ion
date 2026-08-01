/**
 * PanelResizeHandle — the grab strip on a panel's top edge.
 *
 * Absolutely positioned rather than a flex child: grabbing it must cause no
 * layout shift in the panel header, and the panel's own content already fills
 * its height exactly (the pane layout assigns every pixel), so inserting a 6px
 * row would take those pixels from a pane.
 *
 * Both panels are bottom-anchored, so dragging UP grows them. The grip styling
 * mirrors `git/Sash` so the two resize affordances in the same panel read as
 * one vocabulary.
 */
import React from 'react'
import { useColors } from '../theme'

export const PANEL_HANDLE_SIZE = 6

export function PanelResizeHandle({
  isResizing,
  onMouseDown,
  testId,
}: {
  isResizing: boolean
  onMouseDown(e: React.MouseEvent): void
  testId: string
}): React.JSX.Element {
  const colors = useColors()
  return (
    <div
      data-ion-ui
      data-testid={testId}
      onMouseDown={onMouseDown}
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: PANEL_HANDLE_SIZE,
        cursor: 'row-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Above the panel's own content so the strip is grabbable over the
        // header, but below any popover the panel portals out.
        zIndex: 1,
        background: isResizing ? colors.surfaceHover : 'transparent',
        transition: isResizing ? 'none' : 'background 0.15s',
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
      }}
      onMouseEnter={(e) => {
        if (!isResizing) (e.currentTarget as HTMLElement).style.background = colors.surfaceHover
      }}
      onMouseLeave={(e) => {
        if (!isResizing) (e.currentTarget as HTMLElement).style.background = 'transparent'
      }}
    >
      <div style={{
        width: 24,
        height: 2,
        borderRadius: 1,
        background: colors.textTertiary,
        opacity: isResizing ? 0.8 : 0.4,
      }} />
    </div>
  )
}
