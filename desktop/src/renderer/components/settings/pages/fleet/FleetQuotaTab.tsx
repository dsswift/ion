/**
 * FleetQuotaTab — the Fleet's provider quota: how many accounts there are
 * and how many are signed in, one card per provider with its limits summed
 * over its accounts, and every account with its own limits. The provider
 * tabs narrow the cards and the accounts to one provider.
 */
import React, { useState } from 'react'
import { ArrowClockwise } from '@phosphor-icons/react'
import type { FleetAccountRow, FleetExpiringAccount, FleetQuotaPool } from '@ion/shared/fleet-view'
import { getProviderDisplayName } from '@ion/shared/types-models'
import { useColors } from '../../../../theme'
import { Button, KIT, Tabs, toneColor, type TabOption } from '../../kit'
import { FleetAccounts } from './FleetAccounts'
import { FleetQuota } from './FleetQuota'
import { ProviderIcon } from '../../../ProviderIcon'

const ALL = '*'

export interface FleetQuotaTabProps {
  accounts: readonly FleetAccountRow[]
  pools: readonly FleetQuotaPool[]
  expiring: readonly FleetExpiringAccount[]
  loading: boolean
  refreshing: boolean
  /** Absent when this view cannot ask a server to read its usage again. */
  onRefresh?: () => void
  switchable: ReadonlySet<string>
  onSwitch(serverId: string): void
  revealEmails: boolean
  now: number
}

export function FleetQuotaTab({ accounts, pools, expiring, loading, refreshing, onRefresh, switchable, onSwitch, revealEmails, now }: FleetQuotaTabProps): React.JSX.Element {
  const colors = useColors()
  const [picked, setPicked] = useState(ALL)
  // A provider whose last account went away leaves the view on every provider.
  const provider = pools.some((pool) => pool.provider === picked) ? picked : ALL
  const shownPools = provider === ALL ? pools : pools.filter((pool) => pool.provider === provider)
  const shownAccounts = provider === ALL ? accounts : accounts.filter((row) => row.provider === provider)
  const signedIn = accounts.filter((row) => row.signedIn).length
  const options: Array<TabOption<string>> = [
    { value: ALL, label: 'All', count: accounts.length },
    ...pools.map((pool) => ({ value: pool.provider, label: getProviderDisplayName(pool.provider), count: pool.accounts, icon: <ProviderIcon provider={pool.provider} size={14} /> })),
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <section aria-label="Quota summary" style={{ fontSize: KIT.fontSmall, color: colors.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
          {loading && accounts.length === 0 ? 'Reading accounts…' : (
            <>
              {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}
              <span style={{ color: colors.textTertiary }}> · </span>
              <span style={{ color: toneColor(colors, 'ok') }}>{signedIn} signed in</span>
              {expiring.length > 0 && (
                <>
                  <span style={{ color: colors.textTertiary }}> · </span>
                  <span style={{ color: toneColor(colors, 'warn') }}>{expiring.length} with weekly quota about to reset unused</span>
                </>
              )}
            </>
          )}
        </section>
        <div style={{ flex: 1 }} />
        {onRefresh && <Button icon={ArrowClockwise} onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh usage'}</Button>}
      </div>
      {pools.length > 1 && <Tabs label="Provider" value={provider} options={options} onChange={setPicked} />}
      <FleetQuota pools={shownPools} accounts={shownAccounts} now={now} />
      <FleetAccounts accounts={shownAccounts} pools={shownPools} expiring={expiring} loading={loading} switchable={switchable} onSwitch={onSwitch} revealEmails={revealEmails} now={now} />
    </div>
  )
}
