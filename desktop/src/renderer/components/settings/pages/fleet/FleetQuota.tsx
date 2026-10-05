/**
 * FleetQuota — each provider's quota across the Fleet as a card: its first
 * limit summed over its accounts, 100% per account, with one bar segment
 * per account and its next few resets, and its other limits under it.
 */
import React from 'react'
import { fleetLimit, fleetLimitExpired, type FleetAccountRow, type FleetQuotaLimit, type FleetQuotaPool } from '@ion/shared/fleet-view'
import { getProviderDisplayName } from '@ion/shared/types-models'
import { useColors } from '../../../../theme'
import { KIT, toneColor } from '../../kit'
import { formatUntil, formatWhen } from '../../fleet/fleet-format'
import { ProviderIcon } from '../../../ProviderIcon'
import { usageTone } from './UsageMeter'

/** The name a summed limit is shown under: a model's weekly limit by its model. */
export function quotaLimitTitle(limit: Pick<FleetQuotaLimit, 'kind' | 'label'>): string {
  if (limit.kind === 'session') return '5-hour'
  if (limit.kind === 'weekly') return '7-day'
  if (limit.kind === 'weekly_model') return `7-day ${limit.label ?? 'model'}`
  return limit.label ?? limit.kind
}

function left(limit: Pick<FleetQuotaLimit, 'used' | 'capacity'>): number {
  return Math.max(limit.capacity - Math.round(limit.used), 0)
}

/** One segment per account that reports the limit, filled by that account's own use. */
function Segments({ limit, rows, now }: { limit: FleetQuotaLimit; rows: readonly FleetAccountRow[]; now: number }): React.JSX.Element {
  const colors = useColors()
  const parts = rows.flatMap((row) => {
    const own = fleetLimit(row, limit.kind, limit.label)
    return own ? [{ key: row.key, percent: fleetLimitExpired(own, now) ? 0 : Math.min(Math.max(own.percent, 0), 100), signedIn: row.signedIn }] : []
  })
  return (
    <span role="meter" aria-valuemin={0} aria-valuemax={limit.capacity} aria-valuenow={Math.round(limit.used)} aria-label={`${quotaLimitTitle(limit)}: ${Math.round(limit.used)}% of ${limit.capacity}% used`} style={{ display: 'flex', gap: 4 }}>
      {parts.map((part) => (
        <span key={part.key} style={{ flex: 1, height: 4, borderRadius: 2, background: colors.borderSubtle, overflow: 'hidden' }}>
          <span style={{ display: 'block', width: `${part.percent}%`, height: '100%', borderRadius: 2, background: toneColor(colors, part.signedIn ? usageTone(part.percent) : 'muted') }} />
        </span>
      ))}
    </span>
  )
}

/** How many upcoming resets a card lists under its headline limit. */
const SHOWN_RESETS = 3

/**
 * The headline limit's next resets, one line each with how much it gives
 * back. Accounts reset on their own clocks, so no one time resets the pool.
 */
function UpcomingResets({ limit, now }: { limit: FleetQuotaLimit; now: number }): React.JSX.Element | null {
  const colors = useColors()
  if (limit.resets.length === 0) return null
  return (
    <ul aria-label="Upcoming resets" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2, fontSize: KIT.fontTiny, color: colors.textTertiary, fontVariantNumeric: 'tabular-nums' }}>
      {limit.resets.slice(0, SHOWN_RESETS).map((reset) => (
        <li key={reset.at} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span><span style={{ color: colors.textSecondary }}>{Math.round(reset.freed)}% back</span> {formatUntil(reset.at, now)}</span>
          <span>{formatWhen(reset.at)}</span>
        </li>
      ))}
    </ul>
  )
}

function PoolCard({ pool, rows, now }: { pool: FleetQuotaPool; rows: readonly FleetAccountRow[]; now: number }): React.JSX.Element {
  const colors = useColors()
  const [first, ...rest] = pool.limits
  return (
    <div style={{ minWidth: 0, padding: `12px ${KIT.inset + 2}px`, display: 'flex', flexDirection: 'column', gap: 8, boxShadow: `1px 0 0 ${colors.borderSubtle}, 0 1px 0 ${colors.borderSubtle}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ProviderIcon provider={pool.provider} />
        <span style={{ fontSize: KIT.font, fontWeight: 600, color: colors.textPrimary }}>{getProviderDisplayName(pool.provider)}</span>
        <span style={{ marginLeft: 'auto', fontSize: KIT.fontTiny, color: colors.textTertiary }}>{pool.accounts} {pool.accounts === 1 ? 'account' : 'accounts'}</span>
      </div>
      {!first ? <div style={{ fontSize: KIT.fontSmall, color: colors.textTertiary }}>No usage limits reported.</div> : (
        <>
          <div>
            <div style={{ fontSize: KIT.fontSmall, color: colors.textSecondary }}>{quotaLimitTitle(first)}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.25, color: colors.textPrimary }}>{Math.round(first.used)}%</span>
              <span style={{ fontSize: KIT.fontSmall, color: colors.textTertiary }}>of {first.capacity}% used</span>
            </div>
          </div>
          <Segments limit={first} rows={rows} now={now} />
          <div style={{ fontSize: KIT.fontTiny, color: colors.textSecondary }}>{left(first)}% left</div>
          <UpcomingResets limit={first} now={now} />
          {rest.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 8, borderTop: `1px solid ${colors.borderSubtle}` }}>
              {rest.map((limit) => (
                <div key={`${limit.kind}|${limit.label ?? ''}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: KIT.fontSmall, fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ color: colors.textSecondary }}>{quotaLimitTitle(limit)}</span>
                  <span style={{ color: colors.textPrimary }}>{Math.round(limit.used)}% <span style={{ color: colors.textTertiary }}>of {limit.capacity}% · {left(limit)}% left</span></span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function FleetQuota({ pools, accounts, now }: { pools: readonly FleetQuotaPool[]; accounts: readonly FleetAccountRow[]; now: number }): React.JSX.Element | null {
  const colors = useColors()
  if (pools.length === 0) return null
  return (
    <section aria-label="Quota" data-settings-anchor="fleet-quota" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.groupRadius, background: colors.surfacePrimary, overflow: 'hidden' }}>
      {pools.map((pool) => <PoolCard key={pool.provider} pool={pool} rows={accounts.filter((row) => row.provider === pool.provider)} now={now} />)}
    </section>
  )
}
