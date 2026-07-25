// EngineNotificationToasts — vertically stacked, individually dismissable
// toast notifications for engine tabs.
//
// Extracted from EngineView.tsx (which sits near the 600-line cap) and
// reworked from the original single-position overlay:
//   - Toasts previously all rendered absolutely at the same spot
//     (bottom: 32, right: 12) and visually overlapped when more than one
//     was live. They now render as normal flow children of a bottom-right
//     anchored flex column, so each toast is individually readable.
//   - Each toast carries its own X button so the user can dismiss it at
//     their discretion.
//   - Auto-dismiss is per-toast: each toast owns a 5s timer keyed to its
//     unique notification id and removes exactly itself when it ages out.
//     The previous mechanism was one shared timer that fired 5s after the
//     list length changed and removed the list HEAD — a positional
//     heuristic that (a) let early toasts outlive their window whenever a
//     newer toast reset the timer and (b) would have raced with manual
//     dismissal once the X button existed (closing the head toast would
//     make the shared timer remove the wrong sibling).
//
// Scoping note: notifications are already scoped per engine tab —
// the store keys `engineNotifications` by the bare tabId (after session-key
// unification, #256) and EngineView selects only the active tab's list. This
// component is purely presentational; switching sub-tabs unmounts these toasts
// and the per-toast timers restart on remount (acceptable for ephemeral signals).

import React, { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useInteractiveState } from '../hooks/useInteractiveState'
import { transitions, type ColorPalette } from '../theme-tokens'

/** Shape of one entry in the store's engineNotifications lists.
 *  Mirrors session-store-types.ts → State.engineNotifications. */
export interface EngineNotification {
  id: string
  message: string
  level: string
  timestamp: number
}

interface Props {
  notifications: EngineNotification[]
  /** Remove the notification with this id from the active instance's list.
   *  Called by both the X button and each toast's auto-dismiss timer. */
  onDismiss: (id: string) => void
}

/** How long a toast stays visible before auto-dismissing itself. */
const AUTO_DISMISS_MS = 5000

/** Maximum number of toasts shown at once. Newest wins: we render the
 *  TAIL of the list (`slice(-MAX_VISIBLE)`) so fresh toasts are never
 *  starved by a backlog of old ones — the original code rendered the
 *  oldest three (`slice(0, 3)`), which hid new signals behind stale ones. */
const MAX_VISIBLE = 4

/** Level → background color, resolved from the active theme palette. */
function toastBackground(level: string, colors: ColorPalette): string {
  if (level === 'error') return colors.stopBg
  if (level === 'warning') return colors.statusWarning
  return colors.surfaceSecondary
}

/** One toast row: message text + X button + own auto-dismiss timer.
 *  Hovering the toast pauses the auto-dismiss countdown (the remaining
 *  window is preserved and resumes on mouse-leave), so a toast being
 *  read never vanishes mid-read. */
function Toast({ notif, onDismiss }: { notif: EngineNotification; onDismiss: (id: string) => void }) {
  const colors = useColors()
  const closeIx = useInteractiveState()
  const [hovered, setHovered] = useState(false)
  // Milliseconds left in this toast's auto-dismiss window. Decremented on
  // every effect cleanup (hover pause, dep change) so pauses accumulate
  // correctly instead of restarting the full window.
  const remainingRef = useRef(AUTO_DISMISS_MS)
  // Per-toast auto-dismiss. The timer is keyed to THIS notification's id,
  // so it removes exactly this toast regardless of siblings being added
  // or removed in the meantime. Cleared on unmount (tab switch, manual
  // dismiss) — unmounting and remounting restarts the 5s window. While
  // hovered no timer is scheduled; the cleanup records how much of the
  // window was consumed so the countdown resumes where it left off.
  useEffect(() => {
    if (hovered) return
    const started = Date.now()
    const timer = setTimeout(() => onDismiss(notif.id), remainingRef.current)
    return () => {
      clearTimeout(timer)
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - started))
    }
  }, [hovered, notif.id, onDismiss])

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        maxWidth: 300,
        padding: '8px 12px',
        borderRadius: 8,
        fontSize: 12,
        background: toastBackground(notif.level, colors),
        color: colors.textOnAccent,
        boxShadow: colors.cardShadow,
        // Toasts overlay the scrollable conversation area; without this
        // the column container's pointerEvents: 'none' (which lets clicks
        // pass through the empty anchor region) would also swallow the
        // X button clicks.
        pointerEvents: 'auto',
      }}
    >
      <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {notif.message}
      </span>
      <button
        onClick={() => onDismiss(notif.id)}
        title="Dismiss"
        {...closeIx.handlers}
        className="ion-focusable"
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Toasts have solid semantic backgrounds, so pressed layers the
          // white-alpha surfacePressed token on top of the toast fill.
          background: closeIx.pressed ? colors.surfacePressed : 'transparent',
          border: 'none',
          padding: 2,
          marginTop: 1,
          borderRadius: 4,
          cursor: 'pointer',
          color: closeIx.hover ? colors.textOnAccent : colors.textOnAccentMuted,
          transition: `background ${transitions.base}, color ${transitions.base}`,
        }}
      >
        <X size={12} weight="bold" />
      </button>
    </motion.div>
  )
}

export function EngineNotificationToasts({ notifications, onDismiss }: Props) {
  // Newest MAX_VISIBLE entries, oldest at the top / newest at the bottom
  // (closest to where the user's eye rests near the input row).
  const visible = notifications.slice(-MAX_VISIBLE)

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 32,
        right: 12,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
        zIndex: 3,
        // Let clicks pass through the (mostly empty) anchor column;
        // individual toasts re-enable pointer events for the X button.
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence>
        {visible.map((notif) => (
          <Toast key={notif.id} notif={notif} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  )
}
