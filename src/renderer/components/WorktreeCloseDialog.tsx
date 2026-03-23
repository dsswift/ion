import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Warning } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

interface WorktreeCloseDialogProps {
  /** Number of uncommitted files */
  uncommittedCount: number
  /** Number of unpushed commits */
  unpushedCount: number
  /** The global default completion strategy */
  defaultStrategy: 'merge' | 'pr'
  /** Called with the chosen strategy */
  onFinish: (strategy: 'merge' | 'pr') => void
  /** Force-remove worktree and close tab */
  onDiscard: () => void
  /** Dismiss dialog, keep tab open */
  onCancel: () => void
}

export function WorktreeCloseDialog({
  uncommittedCount,
  unpushedCount,
  defaultStrategy,
  onFinish,
  onDiscard,
  onCancel,
}: WorktreeCloseDialogProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()

  // Escape key dismisses
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  if (!popoverLayer) return null

  const alternateStrategy = defaultStrategy === 'merge' ? 'pr' : 'merge'
  const primaryLabel = defaultStrategy === 'merge' ? 'Merge & Close' : 'PR & Close'
  const secondaryLabel = defaultStrategy === 'merge' ? 'Create PR instead' : 'Merge instead'

  // Build status line
  const parts: string[] = []
  if (uncommittedCount > 0) {
    parts.push(`${uncommittedCount} uncommitted file${uncommittedCount !== 1 ? 's' : ''}`)
  }
  if (unpushedCount > 0) {
    parts.push(`${unpushedCount} unpushed commit${unpushedCount !== 1 ? 's' : ''}`)
  }
  const statusText = parts.join(', ')

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
          borderRadius: 24,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: 20,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Warning size={22} weight="fill" style={{ color: '#f59e0b', flexShrink: 0 }} />
          <span style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600 }}>
            Worktree has unmerged changes
          </span>
        </div>

        {/* Status details */}
        {statusText && (
          <p style={{ color: colors.textSecondary, fontSize: 13, margin: '0 0 20px', lineHeight: 1.4 }}>
            {statusText}
          </p>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Primary: default strategy */}
          <button
            data-coda-ui
            onClick={() => onFinish(defaultStrategy)}
            style={{
              background: colors.accent,
              color: colors.textOnAccent,
              border: 'none',
              borderRadius: 10,
              padding: '9px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = colors.sendHover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = colors.accent)}
          >
            {primaryLabel}
          </button>

          {/* Secondary: alternate strategy */}
          <button
            data-coda-ui
            onClick={() => onFinish(alternateStrategy)}
            style={{
              background: 'none',
              color: colors.textSecondary,
              border: 'none',
              borderRadius: 10,
              padding: '9px 16px',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = colors.textPrimary)}
            onMouseLeave={(e) => (e.currentTarget.style.color = colors.textSecondary)}
          >
            {secondaryLabel}
          </button>

          {/* Danger: discard */}
          <button
            data-coda-ui
            onClick={onDiscard}
            style={{
              background: colors.stopBg,
              color: colors.textOnAccent,
              border: 'none',
              borderRadius: 10,
              padding: '9px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = colors.stopHover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = colors.stopBg)}
          >
            Discard & Close
          </button>

          {/* Cancel */}
          <button
            data-coda-ui
            onClick={onCancel}
            style={{
              background: 'none',
              color: colors.textTertiary,
              border: 'none',
              padding: '6px 16px',
              fontSize: 12,
              cursor: 'pointer',
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = colors.textSecondary)}
            onMouseLeave={(e) => (e.currentTarget.style.color = colors.textTertiary)}
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>,
    popoverLayer,
  )
}
