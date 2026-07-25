import React, { useEffect, useRef } from 'react'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const colors = useColors()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelIx = useInteractiveState()
  const confirmIx = useInteractiveState()

  useEffect(() => {
    confirmRef.current?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: colors.scrim,
        zIndex: 10000,
        pointerEvents: 'auto',
      }}
      onClick={onCancel}
    >
      <div
        data-ion-ui
        onClick={(e) => e.stopPropagation()}
        className="rounded-xl"
        style={{
          width: 280,
          background: colors.popoverBg,
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: `1px solid ${colors.popoverBorder}`,
          boxShadow: colors.popoverShadow,
          padding: 16,
        }}
      >
        <div className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
          {title}
        </div>
        <div className="text-[11px] mt-1.5" style={{ color: colors.textSecondary, lineHeight: '16px' }}>
          {message}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            {...cancelIx.handlers}
            className="ion-focusable text-[11px] px-3 py-1 rounded-md"
            style={{
              color: colors.textSecondary,
              border: `1px solid ${colors.containerBorder}`,
              background: interactiveBg(colors, cancelIx),
              cursor: 'pointer',
              transition: `background ${transitions.base}`,
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            {...confirmIx.handlers}
            className="ion-focusable text-[11px] px-3 py-1 rounded-md font-medium"
            style={{
              color: colors.textOnAccent,
              // Destructive confirms use the stop family (no dedicated
              // pressed token — stopHover serves both active states);
              // neutral confirms darken through the accent ladder.
              background: danger
                ? (confirmIx.hover || confirmIx.pressed ? colors.stopHover : colors.stopBg)
                : confirmIx.pressed ? colors.accentPressed : confirmIx.hover ? colors.accentHover : colors.accent,
              border: 'none',
              cursor: 'pointer',
              transition: `background ${transitions.base}`,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
