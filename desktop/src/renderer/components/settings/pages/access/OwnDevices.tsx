/**
 * OwnDevices — the Devices section for a connection without admin on the
 * server, such as a person signed in to a web Studio. It lists only that
 * person's own paired devices (`environment.devices`) and pairs another one
 * as them: the phone's QR code and the pairing link both come from the
 * non-admin action, so the device acts as this person with their scopes.
 * Revoking a pairing stays with an admin.
 */
import React, { useEffect, useState } from 'react'
import { Copy, Desktop, DeviceMobile, Plus, Link } from '@phosphor-icons/react'
import { CLIENTS_CHANGED_CHANNEL } from '@ion/shared/types-environment-admin'
import type { PairedDevice } from '@ion/shared/types-environment-admin'
import { environmentClient, useEnvironmentResource, onEnvironmentEvent, formatAgo } from '../../environment/environment-client'
import { useSettingsEnvironment } from '../../settings-servers'
import { Button, CellText, Chip, DataList, EmptyState, Notice, Stack } from '../../kit'
import { PairPhonePanel } from './PairPhonePanel'
import { PairingLinkPanel } from './PairingLinkPanel'
import { OWN_PAIRING } from './pairing-access'
import { copyText } from './access-parts'
import { rInfo } from '../../../../rendererLogger'

export function OwnDevices(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const devices = useEnvironmentResource(env.id, environmentClient.listOwnDevices)
  const [panel, setPanel] = useState<'phone' | 'link' | null>(null)
  const refreshDevices = devices.refresh
  useEffect(() => onEnvironmentEvent(env.id, CLIENTS_CHANGED_CHANNEL, refreshDevices), [env.id, refreshDevices])

  return (
    <Stack gap={8}>
      {devices.error && <Notice tone="warn">Your devices could not be listed. {devices.error}</Notice>}
      <DataList<PairedDevice>
        label="Your devices"
        title="Your devices"
        description={`The phones and desktops paired to ${env.label} as you. Each acts as you, with your access.`}
        anchor="devices"
        items={devices.data ?? []}
        loading={devices.loading && !devices.data}
        getKey={(d) => d.clientId}
        noun={['device', 'devices']}
        filter={(d, q) => (d.label || 'Unnamed device').toLowerCase().includes(q)}
        showHeader
        columns={[
          { id: 'device', header: 'Device', render: (d) => <>{d.kind === 'mobile' ? <DeviceMobile size={13} aria-hidden /> : <Desktop size={13} aria-hidden />}<CellText>{d.label || 'Unnamed device'}</CellText></> },
          { id: 'kind', header: '', render: (d) => <>
            <Chip>{d.kind === 'mobile' ? 'phone' : 'desktop'}</Chip>
            {d.self && <Chip tone="accent">this device</Chip>}
          </> },
          { id: 'seen', header: 'Last seen', width: '96px', render: (d) => <CellText muted>{d.connected ? 'connected now' : formatAgo(d.lastSeen)}</CellText> },
          { id: 'paired', header: 'Paired', width: '96px', render: (d) => <CellText muted>{formatAgo(d.pairedAt)}</CellText> },
        ]}
        rowMenu={(d) => [{ label: 'Copy id', icon: Copy, onSelect: () => copyText('devices-section', d.clientId) }]}
        actions={<>
          <Button icon={Link} onClick={() => setPanel('link')}>Pairing link</Button>
          <Button variant="primary" icon={Plus} disabled={panel === 'phone'} onClick={() => { rInfo('devices-section', 'pair a phone opened', { environment_id: env.id, access: OWN_PAIRING.kind }); setPanel('phone') }}>Pair a phone</Button>
        </>}
        empty={<EmptyState icon={DeviceMobile} title="No devices paired as you." detail="Pair a phone, or mint a pairing link for another desktop." />}
      />
      {panel === 'phone' && <PairPhonePanel environmentId={env.id} environmentLabel={env.label} access={OWN_PAIRING} onClose={(outcome) => {
        rInfo('devices-section', 'pair a phone closed', { environment_id: env.id, access: OWN_PAIRING.kind, outcome })
        setPanel(null)
        devices.refresh()
      }} />}
      {panel === 'link' && <PairingLinkPanel access={OWN_PAIRING} onClose={() => setPanel(null)} />}
    </Stack>
  )
}
