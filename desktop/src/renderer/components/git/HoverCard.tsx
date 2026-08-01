/**
 * HoverCard — the one hover-reveal mechanism in the tree.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `Tooltip` already owned the hard parts of hovering in this app: the 400 ms
 * intent delay, measuring the trigger with `getBoundingClientRect`, portalling
 * into `PopoverLayer` (native tooltips render BEHIND the Electron overlay), and
 * keyboard focus parity. All of that is independent of the content being a
 * single line of text — but it was welded to a `text: string` prop, so the
 * first surface needing a richer reveal would have had to reimplement it.
 *
 * So the mechanism moved here and takes arbitrary content, and `Tooltip` became
 * a thin wrapper over it. One implementation of hover, not two that drift.
 *
 * ── pointerEvents ───────────────────────────────────────────────────────────
 * The card is `pointerEvents: 'none'` like the tooltip it generalises: it is a
 * reveal, not a surface to interact with, and letting the pointer land on it
 * would make it flicker as the cursor crosses the boundary. Anything needing
 * clickable content wants a popover (see WorktreeRowMenu), not this.
 */
import React, { useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { usePopoverLayer } from '../PopoverLayer'
import { useColors } from '../../theme'

interface Props {
  /** What the card shows. Rich content is the reason this component exists. */
  content: React.ReactNode
  /**
   * Plain-text stand-in used when no PopoverLayer is mounted (tests, isolated
   * renders), where a portalled card has nowhere to go. Rendered as the native
   * `title` attribute, so it must be a string.
   */
  fallbackTitle?: string
  children: React.ReactNode
  position?: 'above' | 'below'
  /**
   * Cap on the card's width. A one-line tooltip wants no wrapping; a card
   * listing conversation titles does. `null` keeps the tooltip behaviour
   * (`whiteSpace: nowrap`, no cap).
   */
  maxWidth?: number | null
}

/** Delay before a hover counts as intent. Shared by pointer and keyboard. */
const HOVER_DELAY_MS = 400

export function HoverCard({
  content,
  fallbackTitle,
  children,
  position = 'above',
  maxWidth = null,
}: Props): React.JSX.Element {
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const spanRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)

  // Shared show/hide used for both pointer hover and keyboard focus of the
  // wrapped child (focus/blur bubble from a focusable child to this span in
  // React's synthetic event system). Both paths use the same delay.
  const show = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const r = spanRef.current?.getBoundingClientRect()
      if (r) setRect(r)
    }, HOVER_DELAY_MS)
  }, [])

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setRect(null)
  }, [])

  const posStyle: React.CSSProperties = rect
    ? position === 'below'
      ? { top: rect.bottom + 4, left: rect.left + rect.width / 2, transform: 'translateX(-50%)' }
      : { bottom: window.innerHeight - rect.top + 4, left: rect.left + rect.width / 2, transform: 'translateX(-50%)' }
    : {}

  return (
    <>
      <span
        ref={spanRef}
        style={{ display: 'inline-flex' }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        title={popoverLayer ? undefined : fallbackTitle}
      >
        {children}
      </span>
      {popoverLayer && rect && createPortal(
        <div
          data-testid="hover-card"
          style={{
            position: 'fixed',
            pointerEvents: 'none',
            ...posStyle,
            background: colors.popoverBg,
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: `1px solid ${colors.popoverBorder}`,
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: 10,
            color: colors.textSecondary,
            ...(maxWidth === null
              ? { whiteSpace: 'nowrap' as const }
              : { maxWidth, whiteSpace: 'normal' as const }),
            boxShadow: colors.popoverShadow,
          }}
        >
          {content}
        </div>,
        popoverLayer,
      )}
    </>
  )
}
