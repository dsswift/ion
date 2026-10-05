/** HiddenServers — the servers the connection registry hid or blocked, and why. Follows the registry, so phase changes show live. */
import React, { useEffect, useState } from 'react'
import { ArrowClockwise } from '@phosphor-icons/react'
import type { EnvironmentCatalogEntry, EnvironmentPhaseState } from '@ion/shared/types-environments'
import { registry } from '../../../../studio/connection/registry'
import { rInfo } from '../../../../rendererLogger'
import { useSettingsServers } from '../../settings-servers'
import { Button, CellText, Chip, DataList, EmptyState, Muted } from '../../kit'

function formatLastAttempt(ms: number | undefined): string {
  if (!ms) return '—'
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.round(seconds / 60)}m ago`
}

interface HiddenRow {
  entry: EnvironmentCatalogEntry
  state: EnvironmentPhaseState
}

export function HiddenServers(): React.JSX.Element {
  const { entries } = useSettingsServers()
  const [states, setStates] = useState<Map<string, EnvironmentPhaseState>>(() => registry.phaseStates())
  useEffect(() => registry.subscribe(setStates), [])
  const rows: HiddenRow[] = entries
    .map((entry) => ({ entry, state: states.get(entry.id) }))
    .filter((row): row is HiddenRow => row.state !== undefined && (row.state.phase === 'hidden' || row.state.phase === 'blocked'))

  return (
    <DataList
      label="Hidden and blocked"
      title="Hidden and blocked"
      description="Servers this device will not connect to right now, and why."
      anchor="hidden-servers"
      items={rows}
      getKey={(r) => r.entry.id}
      showHeader
      columns={[
        { id: 'label', header: 'Label', width: 'minmax(0, 0.7fr)', render: (r) => <CellText>{r.entry.label}</CellText> },
        { id: 'url', header: 'URL', width: 'minmax(0, 1fr)', render: (r) => <CellText muted>{r.entry.target.kind !== 'local' ? r.entry.target.url : '—'}</CellText> },
        { id: 'phase', header: 'Phase', render: (r) => <Chip tone="error">{r.state.phase}</Chip> },
        { id: 'reason', header: 'Reason', width: 'minmax(0, 1fr)', render: (r) => <CellText muted>{r.state.reason ?? '—'}</CellText> },
        { id: 'last', header: 'Last attempt', align: 'end', render: (r) => <Muted>{formatLastAttempt(r.state.lastAttemptAtMs)}</Muted> },
      ]}
      actions={<Button icon={ArrowClockwise} onClick={() => { rInfo('settings.servers', 'registry refresh requested', {}); registry.refresh() }}>Refresh</Button>}
      empty={<EmptyState title="No hidden or blocked environments." />}
    />
  )
}
