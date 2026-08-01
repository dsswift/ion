import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { createPortal } from 'react-dom'
import { Warning } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

export function CloseTabConfirmDialog({
  title,
  directory,
  warning,
  onConfirm,
  onCancel,
}: {
  title: string
  directory: string
  /**
   * What the operator is walking away from, or null when the close is
   * uneventful. Resolved by `requestCloseTab` before this dialog mounts, so it
   * is correct on first render rather than appearing a beat later.
   */
  warning: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const cancelIx = useInteractiveState()
  const confirmIx = useInteractiveState()

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
        background: colors.scrim,
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
        {/* The worktree warning. Informational, not a refusal: closing never
            removes a worktree, so the copy says what remains and where, and the
            confirm button is unchanged. Rendered only when there is something
            to say — an empty box would train the operator to ignore it. */}
        {warning && (
          <div
            data-testid="close-tab-warning"
            style={{
              fontSize: 11,
              color: colors.textSecondary,
              lineHeight: 1.5,
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              background: colors.surfacePrimary,
              border: `1px solid ${colors.containerBorder}`,
              borderRadius: 8,
              padding: '8px 10px',
            }}
          >
            <Warning size={13} weight="fill" color={colors.worktreeGreen} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{warning}</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button
            onClick={onCancel}
            {...cancelIx.handlers}
            className="ion-focusable px-3 py-1 rounded-lg text-[11px]"
            style={{
              color: colors.textSecondary,
              background: interactiveBg(colors, cancelIx, colors.surfacePrimary),
              border: `1px solid ${colors.containerBorder}`,
              cursor: 'pointer',
              transition: `background ${transitions.base}`,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            {...confirmIx.handlers}
            className="ion-focusable px-3 py-1 rounded-lg text-[11px]"
            style={{
              color: colors.textOnAccent,
              background: confirmIx.pressed ? colors.accentPressed : confirmIx.hover ? colors.accentHover : colors.accent,
              border: 'none',
              cursor: 'pointer',
              transition: `background ${transitions.base}`,
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
