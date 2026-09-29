/**
 * ComposerCollapsedPickers — the single "sliders" control the composer's
 * pickers fold into when the control row is too narrow to lay them out.
 *
 * The menu holds the real picker components, so there is one implementation of
 * each. Those pickers open their own popovers into the same PopoverLayer, which
 * is why this menu does not close on a mousedown inside that layer: closing
 * would unmount the picker whose popover was just clicked, and the click would
 * land on nothing.
 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { SlidersHorizontal } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { usePopoverLayer } from '../PopoverLayer'
import { useViewportClamp } from '../../hooks/useViewportClamp'
import { zoomAnchorEdges } from '../../viewport-zoom'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { Tooltip } from '../git/Tooltip'

export function ComposerCollapsedPickers({ children }: { children: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const state = useInteractiveState()
  useViewportClamp(menuRef, open)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverLayer?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, popoverLayer])

  const toggle = (): void => {
    if (!open && triggerRef.current) {
      const rect = zoomAnchorEdges(triggerRef.current.getBoundingClientRect())
      setPos({ bottom: rect.fromBottom + 6, left: rect.left })
    }
    setOpen((o) => !o)
  }

  return (
    <>
      <Tooltip text="Model, thinking, and mode">
        <button
          ref={triggerRef}
          type="button"
          aria-label="Model, thinking, and mode"
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="composer-collapsed-pickers"
          {...state.handlers}
          onClick={toggle}
          className="flex items-center justify-center rounded-full ion-focusable"
          style={{
            width: 24,
            height: 24,
            color: open ? colors.textPrimary : colors.textSecondary,
            background: interactiveBg(colors, { ...state, selected: open }),
            border: `1px solid ${colors.containerBorder}`,
          }}
        >
          <SlidersHorizontal size={13} />
        </button>
      </Tooltip>
      {open && popoverLayer && createPortal(
        <motion.div
          ref={menuRef}
          data-ion-ui
          data-testid="composer-collapsed-pickers-menu"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl flex flex-col items-start gap-1"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: pos.left,
            padding: 8,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          {children}
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
