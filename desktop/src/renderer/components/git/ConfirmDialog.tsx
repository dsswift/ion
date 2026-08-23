import React, { useEffect, useRef } from 'react'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Optional safe alternative shown between Cancel and the confirm action. */
  alternateLabel?: string
  onAlternate?: () => void
  /** Button that receives keyboard focus when the dialog opens. */
  initialFocus?: 'confirm' | 'cancel' | 'alternate'
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
  /**
   * The operator has made their choice and the operation is running.
   *
   * A busy dialog refuses every dismissal path — both buttons, the backdrop, and
   * Escape. That is deliberate and is not the usual "disable to prevent double
   * submit": closing the dialog would not stop the git operation, it would only
   * hide it, leaving the operator watching a row that has not changed with no
   * indication that anything is in flight. The dialog stays up, inert, and says
   * what it is doing until the call site swaps it for an outcome.
   */
  busy?: boolean
  /** What the in-flight operation is doing, e.g. `'Retiring the worktree…'`. */
  busyLabel?: string
  /**
   * One outcome, one button. An acknowledgement reports a result the operator
   * must read; there is no second choice to offer, so the cancel button is not
   * rendered. Backdrop and Escape stay wired to `onCancel` — an acknowledgement
   * is non-destructive, so dismissing it that way is correct; only the
   * redundant button goes away.
   */
  acknowledge?: boolean
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  alternateLabel,
  onAlternate,
  initialFocus = 'confirm',
  danger = false,
  onConfirm,
  onCancel,
  busy = false,
  busyLabel = 'Working…',
  acknowledge = false,
}: ConfirmDialogProps) {
  const colors = useColors()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const alternateRef = useRef<HTMLButtonElement>(null)
  const cancelIx = useInteractiveState()
  const alternateIx = useInteractiveState()
  const confirmIx = useInteractiveState()
  const resolvedConfirmLabel = confirmLabel ?? (acknowledge ? 'OK' : 'Confirm')

  useEffect(() => {
    const focusTarget = initialFocus === 'cancel'
      ? cancelRef.current
      : initialFocus === 'alternate'
        ? alternateRef.current
        : confirmRef.current
    focusTarget?.focus()
    const handler = (e: KeyboardEvent) => {
      // See `busy` on the props: the choice is already made and Escape cannot
      // unmake it. Suppressing it here also keeps the dialog from vanishing
      // while its own operation is still running.
      if (busy) return
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel, busy, initialFocus])

  const disabledStyle = {
    cursor: 'not-allowed',
    opacity: 0.55,
  } as const

  return (
    <div
      /* Menus dismiss themselves on a mousedown outside their own root, and this
         dialog is a SIBLING of that root — so without this marker a mousedown on
         the confirm button unmounts the dialog before its click can dispatch,
         and the action silently never runs. `useOutsideDismiss` treats anything
         inside `[data-ion-confirm]` as inside the menu. */
      data-ion-confirm
      data-testid="confirm-dialog-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: colors.scrim,
        zIndex: 10000,
        pointerEvents: 'auto',
        padding: 16,
        boxSizing: 'border-box',
        overflowY: 'auto',
      }}
      onClick={busy ? undefined : onCancel}
    >
      <div
        data-ion-ui
        onClick={(e) => e.stopPropagation()}
        className="rounded-xl"
        style={{
          width: alternateLabel ? 400 : 280,
          maxWidth: '100%',
          maxHeight: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          overflowY: 'auto',
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
        <div className="text-[11px] mt-1.5" style={{ color: colors.textSecondary, lineHeight: '16px', overflowWrap: 'anywhere' }}>
          {message}
        </div>
        {busy && (
          /* The whole point of the busy state: a running operation must be
             visible, not inferred from buttons that stopped responding. */
          <div
            data-testid="confirm-dialog-busy"
            className="flex items-center gap-2 mt-3 text-[11px]"
            style={{ color: colors.textSecondary }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 11,
                height: 11,
                border: `2px solid ${colors.containerBorder}`,
                borderTopColor: colors.accent,
                borderRadius: '50%',
                animation: 'spin 0.6s linear infinite',
                flexShrink: 0,
              }}
            />
            <span>{busyLabel}</span>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-4" style={{ flexWrap: alternateLabel ? 'nowrap' : 'wrap' }}>
          {!acknowledge && (
            <button
              ref={cancelRef}
              onClick={onCancel}
              disabled={busy}
              {...cancelIx.handlers}
              className="ion-focusable text-[11px] px-3 py-1 rounded-md"
              style={{
                color: colors.textSecondary,
                border: `1px solid ${colors.containerBorder}`,
                background: interactiveBg(colors, busy ? {} : cancelIx),
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: `background ${transitions.base}`,
                ...(busy ? disabledStyle : {}),
              }}
            >
              {cancelLabel}
            </button>
          )}
          {!acknowledge && alternateLabel && onAlternate && (
            <button
              ref={alternateRef}
              onClick={onAlternate}
              disabled={busy}
              {...alternateIx.handlers}
              className="ion-focusable text-[11px] px-3 py-1 rounded-md"
              style={{
                color: colors.textPrimary,
                border: `1px solid ${colors.containerBorder}`,
                background: interactiveBg(colors, busy ? {} : alternateIx),
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: `background ${transitions.base}`,
                ...(busy ? disabledStyle : {}),
              }}
            >
              {alternateLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={busy}
            {...confirmIx.handlers}
            className="ion-focusable text-[11px] px-3 py-1 rounded-md font-medium"
            style={{
              color: colors.textOnAccent,
              // Destructive confirms use the stop family (no dedicated
              // pressed token — stopHover serves both active states);
              // neutral confirms darken through the accent ladder. A busy
              // button holds its base tone: brightening under a hover it no
              // longer answers would read as still-clickable.
              background: danger
                ? (!busy && (confirmIx.hover || confirmIx.pressed) ? colors.stopHover : colors.stopBg)
                : busy ? colors.accent
                  : confirmIx.pressed ? colors.accentPressed : confirmIx.hover ? colors.accentHover : colors.accent,
              border: 'none',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: `background ${transitions.base}`,
              ...(busy ? disabledStyle : {}),
            }}
          >
            {resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
