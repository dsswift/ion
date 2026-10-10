/**
 * FleetHubsPanel — the Fleet Hubs one server reports to, opened from the
 * Fleet. Each hub shows how its link stands. A hub an admin added here can
 * be removed; one the organization's policy set cannot. Adding a hub takes
 * its web address and its enrollment token, and says whether the hub may
 * manage the server or is only reported to.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Trash } from '@phosphor-icons/react'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import type { FleetHubAddRequest, FleetHubState, FleetHubStatus, FleetHubsList } from '@ion/shared/fleet-hub'
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import { action } from '../../../../host/host-instance'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { useEnvironmentSettingsStore } from '../../../../studio/state/environment-settings-store'
import { Button, Chip, EmptyState, ErrorText, Field, FormGroup, IconButton, MonoLine, Muted, Notice, SidePanel, Stack, Switch, TextInput, type Tone } from '../../kit'
import { formatAgo } from '../../fleet/fleet-format'

const STATE: Record<FleetHubState, { tone: Tone; word: string }> = {
  connecting: { tone: 'muted', word: 'connecting' },
  connected: { tone: 'ok', word: 'reporting' },
  refused: { tone: 'error', word: 'refused' },
  blocked: { tone: 'error', word: 'not allowed' },
  unreachable: { tone: 'warn', word: 'unreachable' },
}

export function FleetHubsPanel({ entry, onClose }: { entry: EnvironmentCatalogEntry | null; onClose(): void }): React.JSX.Element | null {
  return entry ? <FleetHubsFlow key={entry.id} entry={entry} onClose={onClose} /> : null
}

function HubRow({ hub, onRemove }: { hub: FleetHubStatus; onRemove?: () => void }): React.JSX.Element {
  const state = STATE[hub.state]
  return (
    <FormGroup title={hub.label} actions={hub.source === 'added' && onRemove ? <IconButton icon={Trash} label={`Stop reporting to ${hub.label}`} onClick={onRemove} /> : undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px' }}>
        <MonoLine>{hub.url}</MonoLine>
        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
          <Chip tone={state.tone}>{state.word}</Chip>
          <Chip>{hub.manage ? 'May manage this server' : 'Reported to only'}</Chip>
          {hub.source === 'policy' && <Chip>Set by your organization</Chip>}
        </span>
        {hub.detail && <Muted>{hub.detail}</Muted>}
        {hub.lastReportAt !== undefined && <Muted>Last report {formatAgo(hub.lastReportAt, Date.now())}.</Muted>}
      </div>
    </FormGroup>
  )
}

function FleetHubsFlow({ entry, onClose }: { entry: EnvironmentCatalogEntry; onClose(): void }): React.JSX.Element {
  const [list, setList] = useState<FleetHubsList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [manage, setManage] = useState(true)
  const [busy, setBusy] = useState(false)
  // The scopes this connection holds on the server, from its welcome; null until it arrives.
  const scopes = useEnvironmentSettingsStore((s) => s.byEnvironment[entry.id]?.scopes ?? null)
  // Changing a server's hubs needs admin there. Unknown scopes leave the form open: the server still decides.
  const denied = scopes !== null && !scopeSatisfies(scopes, 'admin')

  const read = useCallback(() => {
    action(entry.id, 'fleet.hubs.list', [])
      .then((value) => { setList(value as FleetHubsList); setError(null) })
      .catch((err: unknown) => {
        rWarn('settings.fleet', 'fleet hubs could not be read', { environment_id: entry.id, error: String(err) })
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [entry.id])

  useEffect(() => {
    rInfo('settings.fleet', 'fleet hubs opened', { environment_id: entry.id })
    read()
  }, [read, entry.id])

  /** Runs a change and shows the list the server answers with, or why it refused. */
  const change = (name: 'fleet.hubs.add' | 'fleet.hubs.remove', args: unknown[], done?: () => void): void => {
    setBusy(true)
    action(entry.id, name, args)
      .then((value) => { setList(value as FleetHubsList); setError(null); done?.() })
      .catch((err: unknown) => {
        rWarn('settings.fleet', 'fleet hub change refused', { environment_id: entry.id, action: name, error: String(err) })
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setBusy(false))
  }
  const add = (): void => {
    // The hub shows the server under the name it has here. This device's own server has no such name: it reports under its own.
    const request: FleetHubAddRequest = { url: url.trim(), enrollmentToken: token.trim(), manage, ...(entry.target.kind === 'local' ? {} : { label: entry.label }) }
    change('fleet.hubs.add', [request], () => { setUrl(''); setToken('') })
  }

  return (
    <SidePanel
      open
      title={`Fleet hubs for ${entry.label}`}
      subtitle={`A hub is a page that shows every server reporting to it. ${entry.label} dials out to each hub below and sends what this Fleet page shows.`}
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <Stack gap={16}>
        {list?.restricted && <Notice>Your organization limits which hubs {entry.label} may report to.</Notice>}
        <ErrorText>{error}</ErrorText>
        {list === null ? (error ? null : <Muted>Reading {entry.label}…</Muted>)
          : list.hubs.length === 0 ? <EmptyState title="No hubs." detail={`${entry.label} reports to no hub.`} />
          : <section aria-label="Hubs"><Stack gap={12}>{list.hubs.map((hub) => <HubRow key={hub.url} hub={hub} onRemove={denied ? undefined : () => change('fleet.hubs.remove', [{ url: hub.url }])} />)}</Stack></section>}
        <FormGroup title="Add a hub">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
            {denied && <Notice tone="warn">Adding a hub needs admin access on {entry.label}. Pair this device again with a link that grants it. The enrollment token is not what is missing.</Notice>}
            <Field label="Hub address" hint="The address you open the hub's page at.">
              <TextInput aria-label="Hub address" mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hub.example.org" />
            </Field>
            <Field label="Enrollment token" hint="From the hub's own configuration. It is used once; the hub then issues this server its own credential.">
              <TextInput aria-label="Enrollment token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <Switch checked={manage} onChange={setManage} label="Let this hub manage the server" />
              Let this hub manage the server: refresh usage, restart, and update it
            </label>
            <div><Button variant="primary" onClick={add} disabled={denied || busy || !url.trim() || !token.trim()}>Add hub</Button></div>
          </div>
        </FormGroup>
      </Stack>
    </SidePanel>
  )
}
