/**
 * UsageMeter — one usage limit as a block: its name and the percent used
 * on a line, a bar under it, and when it resets under that. The percent is
 * always written out, so the bar's colour only repeats what the number says.
 */
import React from 'react'
import type { FleetAccountLimit } from '@ion/shared/types-fleet'
import { fleetLimitExpired } from '@ion/shared/fleet-view'
import { useColors } from '../../../../theme'
import { Tooltip } from '../../../git/Tooltip'
import { KIT, toneColor, type Tone } from '../../kit'
import { formatAgo, formatUntil, formatWhen } from '../../fleet/fleet-format'

/** A limit is a warning from 70% used and an error from 90%. */
export function usageTone(percent: number): Tone {
  return percent >= 90 ? 'error' : percent >= 70 ? 'warn' : 'ok'
}

export interface UsageMeterProps {
  /** The limit's name: "5-hour", "7-day Fable". */
  title: string
  limit: FleetAccountLimit | undefined
  /** The account is signed in nowhere, so the number cannot be refreshed. */
  stale: boolean
  now: number
}

export function UsageMeter({ title, limit, stale, now }: UsageMeterProps): React.JSX.Element | null {
  const colors = useColors()
  // An account that does not report this limit leaves its place empty.
  if (!limit) return null
  const expired = fleetLimitExpired(limit, now)
  const percent = Math.round(limit.percent)
  const when = formatWhen(limit.resetsAt)
  const until = formatUntil(limit.resetsAt, now)
  const detail = expired
    ? `Reset ${when ?? ''}. Last read ${formatAgo(limit.fetchedAt, now)}, before the reset.`
    : [`${percent}% used`, when ? `resets ${when}` : null, `read ${formatAgo(limit.fetchedAt, now)}`].filter(Boolean).join(' · ')
  const value = stale ? colors.textTertiary : colors.textPrimary
  return (
    <Tooltip text={detail} style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: KIT.fontSmall }}>
        <span style={{ color: colors.textSecondary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: expired ? colors.textTertiary : value }}>{expired ? '—' : `${percent}%`}</span>
      </span>
      <span
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={expired ? 0 : Math.min(percent, 100)}
        aria-label={`${title}: ${detail}`}
        style={{ display: 'block', height: 3, borderRadius: 2, background: colors.borderSubtle, overflow: 'hidden' }}
      >
        {!expired && <span style={{ display: 'block', width: `${Math.min(Math.max(limit.percent, 0), 100)}%`, height: '100%', borderRadius: 2, background: toneColor(colors, stale ? 'muted' : usageTone(limit.percent)) }} />}
      </span>
      <span style={{ fontSize: KIT.fontTiny, color: colors.textTertiary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {expired ? 'reset since last read' : until ? <><span style={{ color: stale ? undefined : colors.textSecondary }}>{until}</span>{when && ` · ${when}`}</> : 'no reset pending'}
      </span>
    </Tooltip>
  )
}
