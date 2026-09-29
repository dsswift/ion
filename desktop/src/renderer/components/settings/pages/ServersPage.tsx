/**
 * ServersPage — every Ion Studio Server this device can reach, one row
 * each: its live status, how it is reached, and its phase. A row opens the
 * server's Overview; its `…` menu renames or removes it. Add server opens
 * the add flow in a side panel (also opened by the sidebar's + button).
 * Below, the servers the connection registry hid or blocked, and why.
 */
import React, { useEffect, useState } from 'react'
import { ArrowClockwise, ArrowSquareOut, PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import type { EnvironmentCatalogEntry, EnvironmentPhaseState } from '@ion/shared/types-environments'
import { registry } from '../../../studio/connection/registry'
import { rInfo } from '../../../rendererLogger'
import { useSettingsServers } from '../settings-servers'
import { useSettingsNav } from '../settings-nav'
import { describeReach, phaseStatus, usePhase } from '../server-status'
import { Button, CellText, Chip, DataList, EmptyState, Stack, StatusDot, Muted } from '../kit'
import { AddServerPanel } from './AddServerPanel'
import { RemoveServerPanel } from './RemoveServerPanel'
import { RenameServerPanel } from './RenameServerPanel'

const isLocalEntry = (e: EnvironmentCatalogEntry): boolean => e.target.kind === 'local'
const isManaged = (e: EnvironmentCatalogEntry): boolean => e.target.kind !== 'local' && e.target.managed === true

function StatusName({ entry }: { entry: EnvironmentCatalogEntry }): React.JSX.Element {
  const status = phaseStatus(entry.id, usePhase(entry.id))
  return <><StatusDot tone={status.tone} label={status.label} /><CellText>{entry.label}</CellText></>
}

function PhaseCell({ entry }: { entry: EnvironmentCatalogEntry }): React.JSX.Element {
  const status = phaseStatus(entry.id, usePhase(entry.id))
  return isManaged(entry) ? <Chip>Managed</Chip> : <Chip tone={status.tone}>{status.label}</Chip>
}

export function ServersPage(): React.JSX.Element {
  const servers = useSettingsServers()
  const { location, navigate } = useSettingsNav()
  const [adding, setAdding] = useState(location.anchor === 'add-server')
  const [renaming, setRenaming] = useState<EnvironmentCatalogEntry | null>(null)
  const [removing, setRemoving] = useState<EnvironmentCatalogEntry | null>(null)

  // The sidebar's + navigates here with this anchor; each such navigation opens the panel.
  useEffect(() => { if (location.anchor === 'add-server') setAdding(true) }, [location])

  const open = (entry: EnvironmentCatalogEntry): void => navigate({ pageId: 'overview', environmentId: entry.id, anchor: null })

  return (
    <Stack gap={20}>
      <div data-settings-anchor="add-server">
        <DataList
          label="Servers"
          anchor="servers-list"
          items={servers.entries}
          getKey={(e) => e.id}
          noun={['server', 'servers']}
          filter={(e, q) => e.label.toLowerCase().includes(q) || describeReach(e.target).toLowerCase().includes(q)}
          showHeader
          columns={[
            { id: 'name', header: 'Name', width: 'minmax(0, 0.8fr)', render: (e) => <StatusName entry={e} /> },
            { id: 'reach', header: 'Reached via', width: 'minmax(0, 1.2fr)', render: (e) => <CellText muted>{isLocalEntry(e) ? 'The server on this Mac' : describeReach(e.target)}</CellText> },
            { id: 'phase', header: 'Status', render: (e) => <PhaseCell entry={e} /> },
          ]}
          onRowClick={open}
          rowMenu={(e) => [
            { label: 'Open', icon: ArrowSquareOut, onSelect: () => open(e) },
            !isLocalEntry(e) && { label: 'Rename', icon: PencilSimple, onSelect: () => setRenaming(e) },
            !isLocalEntry(e) && !isManaged(e) && { label: 'Remove…', icon: Trash, danger: true, onSelect: () => setRemoving(e) },
          ]}
          actions={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add server</Button>}
          loading={servers.entries.length === 0}
        />
      </div>
      <HiddenServers />
      <AddServerPanel open={adding} onClose={() => setAdding(false)} />
      <RenameServerPanel entry={renaming} onClose={() => setRenaming(null)} />
      <RemoveServerPanel entry={removing} onClose={() => setRemoving(null)} />
    </Stack>
  )
}

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

/** Servers the registry hid or blocked. Subscribes to the registry, so phase changes show live. */
function HiddenServers(): React.JSX.Element {
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
