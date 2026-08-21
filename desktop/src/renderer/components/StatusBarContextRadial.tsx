import React, { useEffect, useState } from 'react'
import { useColors } from '../theme'
import { RADIAL_CIRCUMFERENCE, RADIAL_RADIUS, radialDashOffset, radialLevel } from './context-usage'

/* ─── Context Usage Radial ─── */

// Geometry and threshold math live in context-usage.ts (pure, no theme or
// React imports) so the tests exercise the shipped functions directly.

/**
 * Circular context-usage meter. Replaces the former `65%` text readout in
 * the status bar. The caller owns the hover tooltip, the click target, and
 * the accessible name — this renders geometry only.
 *
 * The 16px default is sized to sit level with its status-bar neighbours,
 * whose Phosphor glyphs render at 11-12px (ShieldCheck, Brain, CaretDown).
 * A ring reads visually larger than a glyph at equal box size, so matching
 * the glyph box exactly would look undersized while 20px looked oversized.
 */
export function ContextRadial({ pct, size = 16 }: { pct: number; size?: number }) {
  const colors = useColors()
  const level = radialLevel(pct)
  const stroke = level === 'danger'
    ? colors.dangerFg
    : level === 'warning'
      ? colors.warningFg
      : colors.textTertiary

  // Honour the OS reduced-motion preference: the sweep animation is
  // decorative, the value it lands on is not.
  //
  // Subscribed rather than read once at render: a plain `.matches` read is not
  // reactive, so toggling the OS accessibility setting mid-session would only
  // be honoured on the next unrelated re-render. Both windows mount this (the
  // Studio shell mounts the real StatusBar), so the stale value would persist in
  // whichever window happened not to re-render.
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', onChange)
    // Re-sync on mount in case the preference changed while unmounted.
    setReducedMotion(mq.matches)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      // -90deg so 0% starts at 12 o'clock and fills clockwise.
      style={{ transform: 'rotate(-90deg)', display: 'block' }}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="12"
        cy="12"
        r={RADIAL_RADIUS}
        fill="none"
        stroke={colors.textTertiary}
        strokeWidth="3"
        opacity={0.25}
      />
      <circle
        cx="12"
        cy="12"
        r={RADIAL_RADIUS}
        fill="none"
        stroke={stroke}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={RADIAL_CIRCUMFERENCE}
        strokeDashoffset={radialDashOffset(pct)}
        style={reducedMotion ? undefined : { transition: 'stroke-dashoffset 400ms ease-out' }}
      />
    </svg>
  )
}
