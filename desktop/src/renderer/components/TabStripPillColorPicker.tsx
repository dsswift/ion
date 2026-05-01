import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Prohibit } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { PILL_COLOR_PRESETS, PILL_ICON_PRESETS, PILL_ICON_MAP } from './TabStripShared'

interface PillColorPickerProps {
  anchor: { x: number; y: number }
  currentColor: string | null
  onSelect: (color: string | null) => void
  currentIcon?: string | null
  onSelectIcon?: (icon: string | null) => void
  onClose: () => void
}

/** Popover that lets the user pick a tab-pill color and (optionally) a status icon. */
export function PillColorPicker({
  anchor,
  currentColor,
  onSelect,
  currentIcon,
  onSelectIcon,
  onClose,
}: PillColorPickerProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)

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
      ref={ref}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        left: anchor.x,
        top: anchor.y + 8,
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
      {onSelectIcon && (
        <>
          <div style={{ height: 1, background: colors.textTertiary, opacity: 0.15 }} />
          <div style={{ display: 'flex', gap: 4 }}>
            {PILL_ICON_PRESETS.map((preset) => {
              const isSelected = preset.icon === currentIcon
              const Icon = preset.icon ? PILL_ICON_MAP[preset.icon] : null
              return (
                <button
                  key={preset.icon || 'default'}
                  title={preset.label}
                  onClick={() => { onSelectIcon(preset.icon); onClose() }}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 9999,
                    border: isSelected ? `2px solid ${colors.textPrimary}` : `1px solid ${colors.textTertiary}`,
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    opacity: isSelected ? 1 : 0.7,
                  }}
                >
                  {Icon ? (
                    <Icon size={12} weight="fill" color={colors.textSecondary} />
                  ) : (
                    <span style={{ width: 6, height: 6, borderRadius: 9999, background: colors.textSecondary }} />
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}
    </motion.div>,
    popoverLayer,
  )
}
