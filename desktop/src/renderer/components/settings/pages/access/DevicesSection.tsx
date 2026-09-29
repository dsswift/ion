/**
 * DevicesSection — every desktop and phone paired to this server, one line
 * each, with Revoke in the row menu and the full record in a side panel.
 * "Pair a phone" offers a code and a QR code; "Pairing link" mints the link
 * a second desktop pastes into Add Environment. Rides the `auth.*` actions,
 * so it reads the same credentials.json the server admits from.
 */
import React, { useEffect, useState } from 'react'
import { Copy, Trash, Desktop, DeviceMobile, Plus, Link } from '@phosphor-icons/react'
import { CLIENTS_CHANGED_CHANNEL, DISCOVERY_CHANNEL } from '@ion/shared/types-environment-admin'
import { environmentClient, useEnvironmentResource, onEnvironmentEvent, formatAgo, type PairedClient } from '../../environment/environment-client'
import { useSettingsEnvironment } from '../../settings-servers'
import { Button, CellText, Chip, DataList, EmptyState, ErrorText, Field, Inline, MonoLine, Muted, Notice, SidePanel, Stack, TextArea } from '../../kit'
import { PairPhonePanel } from './PairPhonePanel'
import { copyText, formatFromNow } from './access-parts'
import { host } from '../../../../host/host-instance'
import { rInfo, rWarn } from '../../../../rendererLogger'

/** A device that is connected now reads so; otherwise when it was last seen. */
function lastSeenText(c: PairedClient): string {
  return c.connected ? 'connected now' : formatAgo(c.lastSeen)
}

/** What a pairing's kind is called on screen: the wire says `mobile`, a person says phone. */
function kindLabel(kind: PairedClient['kind']): string {
  return kind === 'mobile' ? 'phone' : 'desktop'
}

const OWN_PAIRING_REASON = 'This is the pairing you are connected through. Remove the environment instead.'

export function DevicesSection(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const clients = useEnvironmentResource(env.id, environmentClient.listClients)
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<'phone' | 'link' | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  // A code used from an open discovery window is announced here, so a device
  // paired that way shows up without anyone reloading the page.
  const refreshClients = clients.refresh
  useEffect(() => onEnvironmentEvent(env.id, DISCOVERY_CHANNEL, refreshClients), [env.id, refreshClients])
  // A pairing completed or a device revoked from anywhere, this window included.
  useEffect(() => onEnvironmentEvent(env.id, CLIENTS_CHANGED_CHANNEL, refreshClients), [env.id, refreshClients])
  // The pairing THIS desktop rides for this server: its welcome names it as
  // `pairedClientId`. Marked and not revocable here.
  const [ownClientId, setOwnClientId] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void host.getEnvCache(env.id).then((cache) => {
      if (cancelled || !cache || cache.welcome.type !== 'studio_welcome') return
      setOwnClientId(cache.welcome.pairedClientId ?? null)
    }).catch((err: unknown) => rWarn('devices-section', 'env cache read failed', { environment_id: env.id, error: String(err) }))
    return () => { cancelled = true }
  }, [env.id])

  const revoke = (c: PairedClient): void => {
    setError(null)
    environmentClient.revokeClient(env.id, c.clientId).then(() => {
      rInfo('devices-section', 'client revoked', { environment_id: env.id })
      setDetailId(null)
      clients.refresh()
    }).catch((err: unknown) => {
      rWarn('devices-section', 'revoke failed', { environment_id: env.id, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const active = (clients.data ?? []).filter((c) => !c.revokedAt)
  const detail = active.find((c) => c.clientId === detailId) ?? null
  return (
    <Stack gap={8}>
      <ErrorText>{error}</ErrorText>
      {clients.error && <Notice tone="warn">Devices need the admin scope on this environment. {clients.error}</Notice>}
      <DataList
        label="Paired devices"
        title="Paired devices"
        description={`Every pairing ${env.label} still admits. Each Add Environment, smoke run, or deploy --pair made one; revoke the ones you no longer use.`}
        anchor="devices"
        items={active}
        loading={clients.loading && !clients.data}
        getKey={(c) => c.clientId}
        noun={['device', 'devices']}
        filter={(c, q) => (c.label || 'Unnamed device').toLowerCase().includes(q)}
        showHeader
        onRowClick={(c) => setDetailId(c.clientId)}
        columns={[
          { id: 'device', header: 'Device', render: (c) => <>{c.kind === 'mobile' ? <DeviceMobile size={13} aria-hidden /> : <Desktop size={13} aria-hidden />}<CellText>{c.label || 'Unnamed device'}</CellText></> },
          { id: 'kind', header: '', render: (c) => <>
            <Chip>{kindLabel(c.kind)}</Chip>
            {c.scopes.includes('admin') && <Chip tone="ok">admin</Chip>}
            {c.clientId === ownClientId && <Chip tone="accent">this desktop</Chip>}
          </> },
          { id: 'seen', header: 'Last seen', width: '96px', render: (c) => <CellText muted>{lastSeenText(c)}</CellText> },
          { id: 'paired', header: 'Paired', width: '96px', render: (c) => <CellText muted>{formatAgo(c.createdAt)}</CellText> },
        ]}
        rowMenu={(c) => [
          { label: 'Copy id', icon: Copy, onSelect: () => copyText('devices-section', c.clientId) },
          { label: 'Revoke', icon: Trash, danger: true, disabled: c.clientId === ownClientId, title: c.clientId === ownClientId ? OWN_PAIRING_REASON : undefined, onSelect: () => revoke(c) },
        ]}
        actions={<>
          <Button icon={Link} onClick={() => setPanel('link')}>Pairing link</Button>
          <Button variant="primary" icon={Plus} disabled={panel === 'phone'} onClick={() => { rInfo('devices-section', 'pair a phone opened', { environment_id: env.id }); setPanel('phone') }}>Pair a phone</Button>
        </>}
        empty={<EmptyState icon={DeviceMobile} title="No paired devices." detail="Pair a phone, or mint a pairing link for another desktop." />}
      />
      {panel === 'phone' && <PairPhonePanel environmentId={env.id} environmentLabel={env.label} onClose={(outcome) => {
        rInfo('devices-section', 'pair a phone closed', { environment_id: env.id, outcome })
        setPanel(null)
        clients.refresh()
      }} />}
      {panel === 'link' && <PairingLinkPanel onClose={() => setPanel(null)} />}
      <DeviceDetailPanel client={detail} own={detail !== null && detail.clientId === ownClientId} onRevoke={revoke} onClose={() => setDetailId(null)} error={error} />
    </Stack>
  )
}

function DeviceDetailPanel({ client, own, onRevoke, onClose, error }: { client: PairedClient | null; own: boolean; onRevoke(c: PairedClient): void; onClose(): void; error: string | null }): React.JSX.Element | null {
  if (!client) return null
  return (
    <SidePanel
      open
      title={client.label || 'Unnamed device'}
      subtitle={`A ${kindLabel(client.kind)} pairing${own ? ' · this desktop' : ''}`}
      onClose={onClose}
      footer={<>
        <Button icon={Copy} onClick={() => copyText('devices-section', client.clientId)}>Copy id</Button>
        <Button variant="danger" icon={Trash} disabled={own} tooltip={own ? OWN_PAIRING_REASON : 'Revoke this pairing'} aria-label={`Revoke ${client.clientId}`} onClick={() => onRevoke(client)}>Revoke</Button>
      </>}
    >
      <Stack>
        <Field label="Paired"><Muted>{formatAgo(client.createdAt)}</Muted></Field>
        <Field label="Last seen"><Muted>{lastSeenText(client)}</Muted></Field>
        <Field label="Id"><MonoLine>{client.clientId}</MonoLine></Field>
        <Field label="Scopes">
          <Inline wrap>
            <span data-testid={`scopes-${client.clientId}`} style={{ display: 'contents' }}>{client.scopes.map((scope) => <Chip key={scope} tone={scope === 'admin' ? 'ok' : 'muted'}>{scope}</Chip>)}</span>
          </Inline>
        </Field>
        <ErrorText>{error}</ErrorText>
      </Stack>
    </SidePanel>
  )
}

/** Mints a pairing link as it opens; the link is a bearer secret, shown once. */
function PairingLinkPanel({ onClose }: { onClose(): void }): React.JSX.Element {
  const env = useSettingsEnvironment()
  const [minted, setMinted] = useState<{ url: string; expiresAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mint = (): void => {
    setBusy(true); setError(null)
    environmentClient.mintPairingLink(env.id, 'another device').then((link) => { setMinted({ url: link.url, expiresAt: link.expiresAt }); rInfo('devices-section', 'pairing link minted', { environment_id: env.id }) }).catch((err: unknown) => {
      rWarn('devices-section', 'mint failed', { environment_id: env.id, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setBusy(false))
  }
  // Mint once per opening; the panel mounts when it opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(mint, [])
  return (
    <SidePanel
      open
      title="Pairing link"
      subtitle={`Lets another desktop pair with ${env.label}.`}
      onClose={onClose}
      footer={<>
        <Button disabled={busy} onClick={mint}>Mint another</Button>
        <Button variant="primary" icon={Copy} disabled={!minted} onClick={() => { if (minted) copyText('devices-section', minted.url) }}>Copy</Button>
      </>}
    >
      <Stack>
        {busy && !minted && <Muted>Minting…</Muted>}
        <ErrorText>{error}</ErrorText>
        {minted && <>
          <Muted>Paste this into Add Environment → Pairing link on the other device. Treat it as a password; it expires {formatFromNow(minted.expiresAt)}.</Muted>
          <TextArea mono readOnly rows={4} value={minted.url} aria-label="Pairing link" />
        </>}
      </Stack>
    </SidePanel>
  )
}
