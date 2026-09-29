/**
 * AddServerPanel — the side panel that adds a server to this device. Four
 * doors picked by a segmented control: Pairing link, Nearby (not offered
 * when the organization seals LAN discovery), SSH, and Sign in. Each door's
 * buttons sit in the panel footer. A server the door returns is added to
 * the catalog and its Overview opens with the finish-setup notice.
 */
import React, { useState } from 'react'
import type { EnvironmentTarget } from '@ion/shared/types-environments'
import { lanDiscoverySealed } from '@ion/shared/enterprise-lan-discovery'
import { policyStore } from '../../../studio/connection/policy-store'
import { rInfo, rWarn } from '../../../rendererLogger'
import { useSettingsServers } from '../settings-servers'
import { useSettingsNav } from '../settings-nav'
import { Button, ErrorText, Field, Segmented, SidePanel, Stack, type SegmentedOption } from '../kit'
import { usePairDoor, useSignInDoor, useSshDoor } from './add-server-doors'
import { useNearbyDoor } from './add-server-nearby'

type Door = 'pair' | 'nearby' | 'ssh' | 'signin'

const DOOR_LABEL: Record<Door, string> = { pair: 'Pairing link', nearby: 'Nearby', ssh: 'SSH', signin: 'Sign in' }

/** Mounts the flow only while open, so every opening starts clean. */
export function AddServerPanel({ open, onClose }: { open: boolean; onClose(): void }): React.JSX.Element | null {
  return open ? <AddServerFlow onClose={onClose} /> : null
}

function AddServerFlow({ onClose }: { onClose(): void }): React.JSX.Element {
  const servers = useSettingsServers()
  const { navigate } = useSettingsNav()
  // An organization can seal LAN discovery; the Nearby door is then not
  // offered at all (the device policy is read from the local environment).
  const nearbySealed = lanDiscoverySealed(policyStore.devicePolicy())
  const doors: Door[] = nearbySealed ? ['pair', 'ssh', 'signin'] : ['pair', 'nearby', 'ssh', 'signin']
  const [door, setDoor] = useState<Door>('pair')
  const [label, setLabel] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const onAdd = (target: EnvironmentTarget): void => {
    setSaving(true); setAddError(null)
    servers.add(target).then((added) => {
      rInfo('settings.add-environment', 'server added to catalog', { environment_id: added?.id ?? '' })
      onClose()
      if (added) navigate({ pageId: 'overview', environmentId: added.id, anchor: null })
    }).catch((err: unknown) => {
      rWarn('settings.add-environment', 'catalog add failed', { error: String(err) })
      setAddError(err instanceof Error ? err.message : String(err))
    }).finally(() => setSaving(false))
  }

  const doorProps = { label, setLabel, onAdd }
  const pair = usePairDoor(doorProps)
  const ssh = useSshDoor(doorProps)
  const signin = useSignInDoor(doorProps)
  const nearby = useNearbyDoor({ active: door === 'nearby' && !nearbySealed, knownEnvironmentIds: new Set(servers.entries.map((e) => e.id)), onAdd })
  const view = { pair, nearby, ssh, signin }[door]
  const busy = view.busy || saving
  const close = (): void => { if (!busy) onClose() }
  const options: ReadonlyArray<SegmentedOption<Door>> = doors.map((d) => ({ value: d, label: DOOR_LABEL[d] }))

  return (
    <SidePanel
      open
      title="Add server"
      subtitle="Pair this device with an Ion Studio Server."
      onClose={close}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
        {view.actions}
      </>}
    >
      <Stack>
        <Field label="How to connect">
          <Segmented<Door> label="How to connect" value={door} options={options} onChange={setDoor} disabled={busy} />
        </Field>
        {view.body}
        <ErrorText>{addError}</ErrorText>
      </Stack>
    </SidePanel>
  )
}
