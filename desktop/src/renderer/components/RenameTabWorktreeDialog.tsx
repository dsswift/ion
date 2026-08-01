import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

/**
 * Rename a conversation AND the worktree it lives in, in one deliberate act.
 *
 * ── Why this is its own verb ────────────────────────────────────────────────
 * A worktree is named ONCE, from the conversation that started it, and the two
 * names are then free to drift: renaming a tab does not touch the worktree, and
 * renaming a worktree does not touch the tab. That is deliberate — a worktree's
 * topic is set by the work it was cut for and does not follow every later
 * relabelling of a conversation inside it.
 *
 * But the operator sometimes DOES want both to change, and the honest way to
 * offer that is an explicit verb rather than a heuristic guessing when a tab
 * rename ought to propagate. This dialog is that verb: one name, typed once,
 * applied to both.
 *
 * ── Pointer events ─────────────────────────────────────────────────────────
 * PopoverLayer is `pointerEvents: 'none'` so it never blocks the page beneath
 * it. The backdrop below therefore sets `pointerEvents: 'auto'` explicitly —
 * without it this renders and is completely non-interactable, with no error.
 */
interface RenameTabWorktreeDialogProps {
  /** Current display name, pre-filled and selected so it can be typed over. */
  defaultTitle: string
  /** The worktree's directory name, shown so the operator sees what is affected. */
  worktreeLabel: string
  onSubmit: (title: string) => void
  onCancel: () => void
}

export function RenameTabWorktreeDialog({
  defaultTitle,
  worktreeLabel,
  onSubmit,
  onCancel,
}: RenameTabWorktreeDialogProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const [title, setTitle] = useState(defaultTitle)
  const inputRef = useRef<HTMLInputElement>(null)
  const applyIx = useInteractiveState()
  const cancelIx = useInteractiveState()

  // Select rather than just focus: the operator is replacing a name, not
  // appending to one.
  useEffect(() => {
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  if (!popoverLayer) return null

  // An empty name would blank both surfaces, so it is not submittable. Same rule
  // the worktree rename IPC enforces on its side.
  const trimmed = title.trim()
  const submittable = trimmed.length > 0

  function submit(): void {
    if (!submittable) return
    onSubmit(trimmed)
  }

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
          width: 340,
          borderRadius: 16,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '14px 16px 0' }}>
          <span style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600 }}>
            Rename tab and worktree
          </span>
          {/* Name the worktree being renamed: the operator is changing two
              things at once and should see the second one. */}
          <div style={{ color: colors.textTertiary, fontSize: 11, marginTop: 4 }}>
            {worktreeLabel}
          </div>
        </div>

        <div style={{ padding: '12px 16px' }}>
          <input
            ref={inputRef}
            data-ion-ui
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 13,
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

        <div
          style={{
            padding: '0 16px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <button
            data-ion-ui
            data-testid="rename-tab-worktree-apply"
            onClick={submit}
            disabled={!submittable}
            {...applyIx.handlers}
            className="ion-focusable"
            style={{
              width: '100%',
              padding: '8px 0',
              fontSize: 13,
              fontWeight: 600,
              background: !submittable
                ? colors.surfaceHover
                : applyIx.pressed ? colors.accentPressed : applyIx.hover ? colors.accentHover : colors.accent,
              color: submittable ? colors.textOnAccent : colors.textTertiary,
              border: 'none',
              borderRadius: 8,
              cursor: submittable ? 'pointer' : 'not-allowed',
              transition: `background ${transitions.base}`,
            }}
          >
            Rename both
          </button>

          <button
            data-ion-ui
            onClick={onCancel}
            {...cancelIx.handlers}
            className="ion-focusable"
            style={{
              width: '100%',
              padding: '4px 0',
              fontSize: 12,
              background: interactiveBg(colors, cancelIx),
              color: colors.textTertiary,
              border: 'none',
              cursor: 'pointer',
              borderRadius: 6,
              transition: `background ${transitions.base}`,
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
