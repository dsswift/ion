import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { createPortal } from 'react-dom'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

export function CloseTabConfirmDialog({
  title,
  directory,
  onConfirm,
  onCancel,
}: {
  title: string
  directory: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel, onConfirm])

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      data-ion-ui
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
        data-ion-ui
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={TRANSITION}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface"
        style={{
          width: 320,
          borderRadius: 16,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>
          Close tab?
        </div>
        <div style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 500 }}>{title}</div>
          <div style={{ color: colors.textTertiary, marginTop: 2 }}>{directory}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button
            onClick={onCancel}
            className="px-3 py-1 rounded-lg text-[11px]"
            style={{
              color: colors.textSecondary,
              background: colors.surfacePrimary,
              border: `1px solid ${colors.containerBorder}`,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1 rounded-lg text-[11px]"
            style={{
              color: '#fff',
              background: colors.accent,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>,
    popoverLayer,
  )
}
