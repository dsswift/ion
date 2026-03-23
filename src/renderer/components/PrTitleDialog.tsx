import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

interface PrTitleDialogProps {
  defaultTitle: string
  onSubmit: (title: string) => void
  onSkipForever: () => void
  onCancel: () => void
}

export function PrTitleDialog({ defaultTitle, onSubmit, onSkipForever, onCancel }: PrTitleDialogProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const [title, setTitle] = useState(defaultTitle)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus and select input on mount
  useEffect(() => {
    inputRef.current?.select()
  }, [])

  // Escape key dismisses
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      data-coda-ui
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <motion.div
        data-coda-ui
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={TRANSITION}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface"
        style={{
          width: 320,
          borderRadius: 16,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '14px 16px 0' }}>
          <span style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600 }}>
            PR Title
          </span>
        </div>

        {/* Input */}
        <div style={{ padding: '12px 16px' }}>
          <input
            ref={inputRef}
            data-coda-ui
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onSubmit(title)
              }
            }}
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 13,
              fontFamily: 'Menlo, Monaco, monospace',
              background: 'transparent',
              border: `1px solid ${colors.inputBorder}`,
              borderRadius: 8,
              color: colors.textPrimary,
              outline: 'none',
              boxSizing: 'border-box',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = colors.inputFocusBorder
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = colors.inputBorder
            }}
          />
        </div>

        {/* Buttons */}
        <div
          style={{
            padding: '0 16px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {/* Primary: Create PR */}
          <button
            data-coda-ui
            onClick={() => onSubmit(title)}
            style={{
              width: '100%',
              padding: '8px 0',
              fontSize: 13,
              fontWeight: 600,
              background: colors.accent,
              color: colors.textOnAccent,
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            Create PR
          </button>

          {/* Secondary: Use generated and don't ask again */}
          <button
            data-coda-ui
            onClick={onSkipForever}
            style={{
              width: '100%',
              padding: '6px 0',
              fontSize: 12,
              background: 'none',
              color: colors.textTertiary,
              border: 'none',
              cursor: 'pointer',
              borderRadius: 6,
            }}
          >
            Use generated and don't ask again
          </button>

          {/* Tertiary: Cancel */}
          <button
            data-coda-ui
            onClick={onCancel}
            style={{
              width: '100%',
              padding: '4px 0',
              fontSize: 12,
              background: 'none',
              color: colors.textTertiary,
              border: 'none',
              cursor: 'pointer',
              borderRadius: 6,
            }}
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>,
    popoverLayer,
  )
}
