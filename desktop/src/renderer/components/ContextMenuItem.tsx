// ContextMenuItem — shared row button for portal context menus (tab pill menu,
// inactive-group menu, and their inline submenus).
//
// Extracted to its own file rather than living inline in
// TabStripTabContextMenu.tsx because that file sits just under the 600-line
// cap. Centralizes the standard interactive-state treatment for menu rows:
// hover/pressed backgrounds via `useInteractiveState` + `interactiveBg`
// (pressed > hover > base), keyboard focus ring via `.ion-focusable`
// (index.css), `transitions.base` on the background per the style-guide
// recipe, and the standard disabled treatment (opacity 0.45, default
// cursor, inert handlers).

import React, { forwardRef } from 'react'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'

export interface ContextMenuItemProps {
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  /** Extra side effect on pointer enter (open a submenu, close sibling
   *  submenus). Suppressed while disabled. */
  onHoverStart?: () => void
  disabled?: boolean
  /** Text color override (e.g. `colors.accent` for "New group...",
   *  `colors.dangerFg` for destructive rows). Defaults to textPrimary;
   *  disabled rows always render textTertiary. */
  color?: string
  title?: string
  children: React.ReactNode
}

export const ContextMenuItem = forwardRef<HTMLButtonElement, ContextMenuItemProps>(
  function ContextMenuItem({ onClick, onHoverStart, disabled = false, color, title, children }, ref) {
    const colors = useColors()
    const { hover, pressed, handlers } = useInteractiveState()
    return (
      <button
        ref={ref}
        title={title}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
        onMouseEnter={() => {
          handlers.onMouseEnter()
          if (!disabled) onHoverStart?.()
        }}
        onMouseLeave={handlers.onMouseLeave}
        onMouseDown={disabled ? undefined : handlers.onMouseDown}
        onMouseUp={disabled ? undefined : handlers.onMouseUp}
        onBlur={handlers.onBlur}
        className="ion-focusable flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
        style={{
          fontSize: 12,
          color: disabled ? colors.textTertiary : (color ?? colors.textPrimary),
          background: disabled ? 'transparent' : interactiveBg(colors, { hover, pressed }),
          border: 'none',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          transition: `background ${transitions.base}`,
        }}
      >
        {children}
      </button>
    )
  },
)
