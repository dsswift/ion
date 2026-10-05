/**
 * FleetServers — one row per server: its name, how it is reached, and its
 * status on the row's line, and what it last reported under it as labelled
 * facts. A server that has not reported shows only where new work stands.
 * A server that is not connected now keeps its last report, dimmed, with
 * its age.
 */
import React from 'react'
import { isManageOnlyTarget, type EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { fleetAccountName, fleetEnterpriseAccountName } from '@ion/shared/fleet-view'
import { getProviderDisplayName } from '@ion/shared/types-models'
import type { FleetReport } from '@ion/shared/types-fleet'
import { useColors } from '../../../../theme'
import { describeReach, phaseStatus, usePhase } from '../../server-status'
import { CellText, Chip, DataList, KIT, StatusDot, type RowMenuItem } from '../../kit'
import { formatAgo, formatPercent } from '../../fleet/fleet-format'

const isLocalEntry = (e: EnvironmentCatalogEntry): boolean => e.target.kind === 'local'
const isManaged = (e: EnvironmentCatalogEntry): boolean => e.target.kind !== 'local' && e.target.managed === true

function reach(entry: EnvironmentCatalogEntry): string {
  return isLocalEntry(entry) ? 'The server on this Mac' : describeReach(entry.target)
}

function Name({ entry }: { entry: EnvironmentCatalogEntry }): React.JSX.Element {
  const status = phaseStatus(entry.id, usePhase(entry.id))
  return (
    <>
      <StatusDot tone={status.tone} label={status.label} />
      <span style={{ fontWeight: 600, flexShrink: 0, maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.label}</span>
      <CellText muted>{reach(entry)}</CellText>
    </>
  )
}

function Phase({ entry }: { entry: EnvironmentCatalogEntry }): React.JSX.Element {
  const status = phaseStatus(entry.id, usePhase(entry.id))
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {isManageOnlyTarget(entry.target) && <Chip>Manage only</Chip>}
      {isManaged(entry) ? <Chip>Managed</Chip> : <Chip tone={status.tone}>{status.label}</Chip>}
    </span>
  )
}

/** CPU and memory in use, from the report's newest sample. */
function load(report: FleetReport): string {
  const host = report.metrics?.host
  if (!host) return '—'
  const memory = host.memoryTotalBytes > 0 ? 1 - host.memoryAvailableBytes / host.memoryTotalBytes : null
  return `cpu ${formatPercent(host.cpuUtilization)} · mem ${formatPercent(memory)}`
}

function devices(report: FleetReport): string {
  return report.devices.connected > 0 ? `${report.devices.paired} · ${report.devices.connected} on` : String(report.devices.paired)
}

function signedInAccounts(report: FleetReport, revealEmails: boolean): string {
  const names = report.accounts.filter((a) => a.signedIn).map((a) => fleetAccountName(a, revealEmails))
  return names.length > 0 ? names.join(', ') : '—'
}

/** Who is signed in to the server's enterprise sign-in. A server that does not report it says so, rather than reading as signed out. */
function enterpriseAccount(report: FleetReport, revealEmails: boolean): string {
  if (report.enterpriseAccount === undefined) return 'not reported'
  return report.enterpriseAccount ? fleetEnterpriseAccountName(report.enterpriseAccount, revealEmails) : 'not signed in'
}

/** The providers that exist only because the server's configuration defines them. A server too old to say who is signed in is too old to mark them. */
function customProviders(report: FleetReport): string {
  if (report.enterpriseAccount === undefined) return 'not reported'
  const names = report.providers.filter((p) => p.custom).map((p) => p.displayName || getProviderDisplayName(p.id))
  return names.length > 0 ? names.join(', ') : 'none'
}

const HUB_STATE_WORDS: Record<string, string> = { connected: 'reporting', connecting: 'connecting', refused: 'refused', blocked: 'not allowed', unreachable: 'unreachable' }

/** The hubs the server reports to, each with how its link stands. */
function fleetHubs(report: FleetReport): string {
  if (report.hubs === undefined) return 'not reported'
  if (report.hubs.length === 0) return 'none'
  return report.hubs.map((h) => `${h.label} (${HUB_STATE_WORDS[h.state] ?? h.state}${h.manage ? '' : ', reports only'})`).join(', ')
}

export interface Fact {
  label: string
  value: string
  mono?: boolean
}

/** What a server last reported, as labelled facts; with no report, only where new work stands. */
export function serverFacts(report: FleetReport | null, standing: string, revealEmails: boolean): Fact[] {
  const placement: Fact = { label: 'New work', value: standing }
  if (!report) return [placement]
  return [
    { label: 'Server', value: report.server.serverVersion ?? '—', mono: true },
    { label: 'Engine', value: report.server.engineVersion ?? '—', mono: true },
    { label: 'Load', value: load(report) },
    { label: 'Running conversations', value: String(report.server.runningConversations ?? '—') },
    { label: 'Devices', value: devices(report) },
    // The model the `standard` tier resolves to: what a new conversation gets by default.
    { label: 'Default model', value: report.modelTiers.find((t) => t.name === 'standard')?.model ?? '—', mono: true },
    { label: 'CLI accounts', value: signedInAccounts(report, revealEmails) },
    { label: 'Enterprise account', value: enterpriseAccount(report, revealEmails) },
    { label: 'Custom providers', value: customProviders(report) },
    { label: 'Fleet hubs', value: fleetHubs(report) },
    placement,
  ]
}

/** The facts wrap rather than truncate: everything a server reported can be read without a tooltip. */
export function ServerFacts({ items, staleNote }: { items: readonly Fact[]; staleNote: string | null }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ padding: '0 0 10px 13px', cursor: 'inherit' }}>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '8px 16px', opacity: staleNote ? 0.7 : 1 }}>
        {items.map((f) => (
          <div key={f.label} style={{ minWidth: 0 }}>
            <dt style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase', color: colors.textTertiary }}>{f.label}</dt>
            <dd style={{ margin: '1px 0 0', fontSize: f.mono ? KIT.fontTiny : KIT.fontSmall, fontFamily: f.mono ? KIT.mono : undefined, lineHeight: 1.4, color: colors.textSecondary, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{f.value}</dd>
          </div>
        ))}
      </dl>
      {staleNote && <div style={{ marginTop: 6, fontSize: KIT.fontTiny, color: colors.textTertiary, whiteSpace: 'normal' }}>{staleNote}</div>}
    </div>
  )
}

export interface FleetServersProps {
  entries: readonly EnvironmentCatalogEntry[]
  report(entry: EnvironmentCatalogEntry): FleetReport | null
  /** When a server that is not connected now was last read; null for a connected one. */
  staleSince(entry: EnvironmentCatalogEntry): number | null
  /** Where the server stands for a new conversation. */
  standing(entry: EnvironmentCatalogEntry): string
  revealEmails: boolean
  now: number
  onOpen(entry: EnvironmentCatalogEntry): void
  menu(entry: EnvironmentCatalogEntry): ReadonlyArray<RowMenuItem | false | null | undefined>
  actions: React.ReactNode
}

export function FleetServers({ entries, report, staleSince, standing, revealEmails, now, onOpen, menu, actions }: FleetServersProps): React.JSX.Element {
  return (
    <DataList
      label="Servers"
      title="Servers"
      anchor="servers-list"
      items={entries}
      getKey={(e) => e.id}
      noun={['server', 'servers']}
      filter={(e, q) => e.label.toLowerCase().includes(q) || describeReach(e.target).toLowerCase().includes(q)}
      columns={[
        { id: 'name', render: (e) => <Name entry={e} /> },
        { id: 'phase', align: 'end', render: (e) => <Phase entry={e} /> },
      ]}
      detail={(e) => {
        const since = report(e) ? staleSince(e) : null
        return <ServerFacts items={serverFacts(report(e), standing(e), revealEmails)} staleNote={since === null ? null : `Not connected now. Last report ${formatAgo(since, now)}.`} />
      }}
      onRowClick={onOpen}
      rowMenu={menu}
      actions={actions}
      loading={entries.length === 0}
    />
  )
}
