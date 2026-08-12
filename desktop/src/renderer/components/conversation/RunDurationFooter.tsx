import React from 'react'
import { useColors } from '../../theme'
import type { TaskCompletionReason } from '../../../shared/types-events'

export function formatRunDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 1_000) return '<1s'

  const seconds = Math.floor(durationMs / 1_000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function runDurationLabel(
  durationMs: number,
  reason?: TaskCompletionReason | (string & {}),
): string {
  const duration = formatRunDuration(durationMs)
  if (reason === 'aborted') return `Stopped after ${duration}`
  if (reason && reason !== 'normal') return `Ended after ${duration}`
  return `Completed in ${duration}`
}

interface RunDurationFooterProps {
  durationMs: number
  reason?: TaskCompletionReason | (string & {})
}

/** Quiet end-of-turn metadata, aligned beneath the tool-activity summary. */
export function RunDurationFooter({ durationMs, reason }: RunDurationFooterProps) {
  const colors = useColors()
  const label = runDurationLabel(durationMs, reason)

  return (
    <div
      aria-label={label}
      style={{
        padding: '2px 0 3px 22px', color: colors.textTertiary,
        fontSize: 10, fontVariantNumeric: 'tabular-nums',
      }}
    >
      {label}
    </div>
  )
}
