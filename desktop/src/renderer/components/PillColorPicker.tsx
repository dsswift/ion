import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Prohibit } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { PILL_COLOR_PRESETS } from './conversation-status'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { scrollableMenuStyle } from '../menu-viewport'

interface PillColorPickerProps {
  anchor: { x: number; y: number }
  currentColor: string | null
  onSelect: (color: string | null) => void
  onClose: () => void
}

/** Popover that lets the user pick a conversation's color. */
export function PillColorPicker({
  anchor,
  currentColor,
  onSelect,
  onClose,
}: PillColorPickerProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  // Measured placement: the picker opens at the pointer, which can sit near a
  // window edge, so "below the anchor" needs a flip there.
  const pos = useAnchoredPopover(anchor)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      ref={(node) => { (ref as React.MutableRefObject<HTMLDivElement | null>).current = node; pos.ref(node) }}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...scrollableMenuStyle(),
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        zIndex: 10000,
      }}
    >
      <div style={{ display: 'flex', gap: 4 }}>
        {PILL_COLOR_PRESETS.map((preset) => {
          const isSelected = preset.color === currentColor
          return (
            <button
              key={preset.color || 'default'}
              title={preset.label}
              onClick={() => { onSelect(preset.color); onClose() }}
              style={{
                width: 18,
                height: 18,
                borderRadius: 9999,
                border: isSelected ? `2px solid ${colors.textPrimary}` : `1px solid ${colors.textTertiary}`,
                background: preset.color || 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                opacity: isSelected ? 1 : 0.7,
              }}
            >
              {preset.color === null && <Prohibit size={12} color={colors.textTertiary} />}
            </button>
          )
        })}
      </div>
    </motion.div>,
    popoverLayer,
  )
}
