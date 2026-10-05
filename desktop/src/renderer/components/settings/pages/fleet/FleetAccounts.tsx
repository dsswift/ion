/**
 * FleetAccounts — the provider accounts across every server, grouped by
 * provider. A row is one account: its name and plan, each of its usage
 * limits as a block, and the servers it has been seen on. A solid chip is a
 * server it is signed in on now; a muted one, a server that saw it in the
 * last 30 days. An account signed in nowhere keeps its last numbers, dimmed,
 * with their age. The chip under a name is the burn-down: weekly quota that
 * will reset with a share left over. A row's menu opens the accounts of a
 * connected server it is on, to sign in to another one there.
 *
 * Every group shares one set of columns, so the same limit lines up from
 * one provider to the next. Where there is no room for the columns side by
 * side, such as a phone, each account's limits stack under its name instead.
 */
import React, { useEffect, useState } from 'react'
import { UserSwitch } from '@phosphor-icons/react'
import { fleetAccountName, fleetLimit, type FleetAccountRow, type FleetExpiringAccount, type FleetQuotaPool } from '@ion/shared/fleet-view'
import type { ExpiringQuota } from '@ion/shared/usage-limit'
import { getProviderDisplayName } from '@ion/shared/types-models'
import { useColors } from '../../../../theme'
import { Tooltip } from '../../../git/Tooltip'
import { CellText, Chip, EmptyState, KIT, RowMenu } from '../../kit'
import { formatAgo, formatUntil } from '../../fleet/fleet-format'
import { quotaLimitTitle } from './FleetQuota'
import { ProviderIcon } from '../../../ProviderIcon'
import { UsageMeter } from './UsageMeter'

/** Narrower than this, the limit columns do not fit beside the account, and each row stacks. */
const STACK_BELOW_PX = 620

/** Whether an element is narrower than `px`. False until it has been measured, and where nothing can measure it. */
function useNarrowerThan(px: number): [(el: HTMLElement | null) => void, boolean] {
  // Held as state so the watch moves when the element is replaced, as it is once the first accounts arrive.
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < px))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el, px])
  return [setEl, narrow]
}

/** How many server chips a row shows before the rest fold into a count. */
const MACHINES_SHOWN = 2

function accountDetail(row: FleetAccountRow, now: number): string {
  const plan = row.label ?? getProviderDisplayName(row.provider)
  return row.signedIn ? plan : `${plan} · last seen ${formatAgo(row.lastSeen, now)}`
}

function Machines({ row, now }: { row: FleetAccountRow; now: number }): React.JSX.Element {
  const rest = row.machines.slice(MACHINES_SHOWN)
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'nowrap' }}>
      {row.machines.slice(0, MACHINES_SHOWN).map((m) => (
        <Tooltip key={m.serverId} text={m.signedIn ? `Signed in on ${m.label} now` : `Seen on ${m.label} ${formatAgo(m.lastSeen, now)}, not signed in there now`}>
          <Chip tone={m.signedIn ? 'ok' : 'muted'}>{m.label}</Chip>
        </Tooltip>
      ))}
      {rest.length > 0 && (
        <Tooltip text={rest.map((m) => (m.signedIn ? `${m.label} (signed in)` : `${m.label} (seen ${formatAgo(m.lastSeen, now)})`)).join(', ')}>
          <Chip>+{rest.length}</Chip>
        </Tooltip>
      )}
    </span>
  )
}

/** What will be lost at the next weekly reset; nothing when the account is on course to use it. */
function Expiring({ expiring, now }: { expiring: readonly ExpiringQuota[] | undefined; now: number }): React.JSX.Element | null {
  const first = expiring?.[0]
  if (!first) return null
  const what = first.limit.kind === 'weekly_model' && first.limit.label ? `7-day ${first.limit.label}` : '7-day'
  return (
    <Tooltip text={`${Math.round(first.unusedPercent)}% of the ${what} limit is unused and resets ${formatUntil(first.limit.resetsAt, now) ?? 'soon'}. Unused quota does not carry over.`}>
      <Chip tone="warn">{Math.round(first.unusedPercent)}% unused</Chip>
    </Tooltip>
  )
}

export interface FleetAccountsProps {
  accounts: readonly FleetAccountRow[]
  /** The providers shown, each with its limits in the order its blocks are laid out. */
  pools: readonly FleetQuotaPool[]
  /** The accounts with weekly quota about to reset unused. */
  expiring: readonly FleetExpiringAccount[]
  loading: boolean
  /** The servers whose accounts can be switched now (the connected ones). */
  switchable: ReadonlySet<string>
  /** Opens the accounts of one server. */
  onSwitch(serverId: string): void
  /** Whether account emails are shown; hidden ones read as a fixed mask. */
  revealEmails: boolean
  now: number
}

export function FleetAccounts({ accounts, pools, expiring, loading, switchable, onSwitch, revealEmails, now }: FleetAccountsProps): React.JSX.Element {
  const colors = useColors()
  const [sectionRef, stacked] = useNarrowerThan(STACK_BELOW_PX)
  const expiringByKey = new Map(expiring.map((entry) => [entry.row.key, entry.expiring]))
  const blocks = Math.max(1, ...pools.map((pool) => pool.limits.length))
  const template = `minmax(150px, 1.1fr) repeat(${blocks}, minmax(120px, 1fr)) max-content ${KIT.controlHeight}px`
  if (accounts.length === 0) {
    return (
      <section ref={sectionRef} aria-label="Accounts" data-settings-anchor="fleet-accounts" style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.groupRadius, background: colors.surfacePrimary }}>
        {loading ? <div style={{ padding: `10px ${KIT.inset}px`, fontSize: KIT.fontSmall, color: colors.textTertiary }}>Loading…</div>
          : <EmptyState title="No provider accounts yet." detail="A server reports an account once its Claude Code or Codex CLI is signed in." />}
      </section>
    )
  }
  const groupHeader = (pool: FleetQuotaPool): React.JSX.Element => (
    <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 2px 6px', borderBottom: `1px solid ${colors.borderSubtle}` }}>
      <ProviderIcon provider={pool.provider} />
      <span style={{ fontSize: KIT.font, fontWeight: 600, color: colors.textPrimary }}>{getProviderDisplayName(pool.provider)}</span>
      <span style={{ fontSize: KIT.fontTiny, color: colors.textTertiary, fontVariantNumeric: 'tabular-nums' }}>{pool.accounts}</span>
    </div>
  )
  const identity = (row: FleetAccountRow): React.JSX.Element => (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', minWidth: 0, fontSize: KIT.font, fontWeight: 600, color: colors.textPrimary }}><CellText>{fleetAccountName(row, revealEmails)}</CellText></span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: KIT.fontTiny }}>
        <CellText muted>{accountDetail(row, now)}</CellText>
        <Expiring expiring={expiringByKey.get(row.key)} now={now} />
      </span>
    </div>
  )
  const menuOf = (row: FleetAccountRow): React.JSX.Element | null => {
    const menu = row.machines.filter((m) => switchable.has(m.serverId)).map((m) => ({ label: `Switch account on ${m.label}…`, icon: UserSwitch, onSelect: () => onSwitch(m.serverId) }))
    return menu.length > 0 ? <RowMenu items={menu} /> : null
  }
  const meter = (row: FleetAccountRow, limit: FleetQuotaPool['limits'][number]): React.JSX.Element => (
    <UsageMeter title={quotaLimitTitle(limit)} limit={fleetLimit(row, limit.kind, limit.label)} stale={!row.signedIn} now={now} />
  )
  if (stacked) {
    return (
      <section ref={sectionRef} aria-label="Accounts" data-settings-anchor="fleet-accounts" style={{ display: 'flex', flexDirection: 'column' }}>
        {pools.map((pool) => (
          <div key={pool.provider} role="list" aria-label={`${getProviderDisplayName(pool.provider)} accounts`} style={{ marginBottom: 8 }}>
            {groupHeader(pool)}
            {accounts.filter((row) => row.provider === pool.provider).map((row) => (
              <div key={row.key} role="listitem" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 2px', borderBottom: `1px solid ${colors.borderSubtle}`, opacity: row.signedIn ? 1 : 0.6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>{identity(row)}</div>
                  <Machines row={row} now={now} />
                  {menuOf(row)}
                </div>
                {pool.limits.some((limit) => fleetLimit(row, limit.kind, limit.label)) && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px 20px' }}>
                    {pool.limits.map((limit) => fleetLimit(row, limit.kind, limit.label) && <div key={`${limit.kind}|${limit.label ?? ''}`} style={{ minWidth: 0 }}>{meter(row, limit)}</div>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </section>
    )
  }
  return (
    <section ref={sectionRef} aria-label="Accounts" data-settings-anchor="fleet-accounts" style={{ display: 'grid', gridTemplateColumns: template, columnGap: 24, overflowX: 'auto' }}>
      {pools.map((pool) => (
        <div key={pool.provider} role="list" aria-label={`${getProviderDisplayName(pool.provider)} accounts`} style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'subgrid', marginBottom: 8 }}>
          {groupHeader(pool)}
          {accounts.filter((row) => row.provider === pool.provider).map((row) => (
            <div key={row.key} role="listitem" style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'subgrid', alignItems: 'center', padding: '12px 2px', borderBottom: `1px solid ${colors.borderSubtle}`, opacity: row.signedIn ? 1 : 0.6 }}>
              {identity(row)}
              {Array.from({ length: blocks }, (_, i) => {
                const limit = pool.limits[i]
                return <div key={i} style={{ minWidth: 0 }}>{limit && meter(row, limit)}</div>
              })}
              <Machines row={row} now={now} />
              <div>{menuOf(row)}</div>
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}
