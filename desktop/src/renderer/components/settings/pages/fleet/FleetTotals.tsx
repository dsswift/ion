/** FleetTotals — the Fleet's servers in a few numbers: how many are online, running conversations, and versions in use. */
import React from 'react'
import type { FleetTotals as Totals } from '@ion/shared/fleet-view'
import { useColors } from '../../../../theme'
import { KIT } from '../../kit'

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ minWidth: 0, padding: `10px ${KIT.inset}px`, boxShadow: `1px 0 0 ${colors.borderSubtle}, 0 1px 0 ${colors.borderSubtle}` }}>
      <div style={{ fontSize: KIT.fontTiny, color: colors.textTertiary }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: colors.textPrimary, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>{value}</div>
      {detail && <div style={{ fontSize: KIT.fontTiny, color: colors.textTertiary, lineHeight: 1.35 }}>{detail}</div>}
    </div>
  )
}

export function FleetTotals({ totals, loading }: { totals: Totals; loading: boolean }): React.JSX.Element {
  const colors = useColors()
  const pending = loading ? '…' : null
  const versions = totals.versions.map((v) => `${v.version} ×${v.servers}`).join(', ')
  return (
    <section aria-label="Fleet totals" data-settings-anchor="fleet-totals" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.groupRadius, background: colors.surfacePrimary, overflow: 'hidden' }}>
      <Tile label="Servers online" value={`${totals.serversOnline} of ${totals.servers}`} />
      <Tile label="Running conversations" value={pending ?? String(totals.runningConversations)} />
      <Tile label="Versions in use" value={pending ?? String(totals.versions.length)} detail={versions || undefined} />
    </section>
  )
}
