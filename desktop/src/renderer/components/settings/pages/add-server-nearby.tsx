/**
 * add-server-nearby — the Add server panel's Nearby door: Studio Servers
 * that made themselves discoverable on this LAN, paired with the one-time
 * code read off the host.
 *
 * Finding a server grants nothing; the code is the trust. It completes the
 * same pairing a pasted link does, so the door builds a link from the found
 * address and the typed code and hands it to the host's `pairEnvironment`.
 * Servers are silent by default, so an empty list is the normal case and
 * says how to change it. An enterprise seal on LAN discovery removes the
 * door altogether (the panel does not offer it).
 */
import React, { useCallback, useEffect, useState } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import type { NearbyStudioServer } from '@ion/shared/types-nearby'
import { LOCAL_ENVIRONMENT_ID, type EnvironmentTarget } from '@ion/shared/types-environments'
import { host } from '../../../host/host-instance'
import { rInfo, rWarn } from '../../../rendererLogger'
import { Button, CellText, Chip, DataList, EmptyState, ErrorText, Field, Muted, Stack, TextInput } from '../kit'
import type { DoorView } from './add-server-doors'

const TAG = 'nearby-door'

/** The link the ordinary pairing door consumes, from a found server and a typed code. */
export function nearbyPairingLink(server: NearbyStudioServer, code: string): string {
  return `ion-studio://pair?code=${encodeURIComponent(code.trim())}&url=${encodeURIComponent(server.url)}&env=${encodeURIComponent(server.label)}`
}

/** Searches each time the door becomes `active`, as opening the door always did. */
export function useNearbyDoor({ active, knownEnvironmentIds, onAdd }: { active: boolean; knownEnvironmentIds: ReadonlySet<string>; onAdd(target: EnvironmentTarget): void }): DoorView {
  const [servers, setServers] = useState<NearbyStudioServer[] | null>(null)
  const [selected, setSelected] = useState<NearbyStudioServer | null>(null)
  const [code, setCode] = useState('')
  const [pairing, setPairing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // This desktop's own server can be discoverable too; it is not a place to add.
  const [selfId, setSelfId] = useState<string | null>(null)
  useEffect(() => {
    void host.getEnvCache(LOCAL_ENVIRONMENT_ID).then((cache) => {
      if (cache && cache.welcome.type === 'studio_welcome') setSelfId(cache.welcome.environmentId)
    }).catch((err: unknown) => rWarn(TAG, 'local environment id unavailable', { error: String(err) }))
  }, [])

  const search = useCallback(() => {
    setServers(null); setError(null)
    host.browseNearby().then((found) => {
      rInfo(TAG, 'browse answered', { found: found.length })
      setServers(found)
    }).catch((err: unknown) => {
      rWarn(TAG, 'browse failed', { error: String(err) })
      setServers([]); setError(err instanceof Error ? err.message : String(err))
    })
  }, [])
  useEffect(() => {
    if (!active) return
    setSelected(null); setCode('')
    search()
  }, [active, search])

  const pair = async (): Promise<void> => {
    if (!selected) return
    setPairing(true); setError(null)
    const result = await host.pairEnvironment(nearbyPairingLink(selected, code), selected.label)
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
    setPairing(false)
    if (!result.ok) {
      rWarn(TAG, 'pairing refused', { environment_id: selected.environmentId, error: result.error })
      setError(result.error === 'not_found' ? 'That code is not live on the server. Check it, or ask for a fresh one.' : result.error)
      return
    }
    rInfo(TAG, 'paired with a nearby server', { environment_id: selected.environmentId })
    onAdd(result.target)
  }

  const isSelf = (s: NearbyStudioServer): boolean => s.environmentId !== '' && s.environmentId === selfId
  const isKnown = (s: NearbyStudioServer): boolean => isSelf(s) || (s.environmentId !== '' && knownEnvironmentIds.has(s.environmentId))

  const body = (
    <Stack>
      <Muted>Servers on this network that are discoverable right now. A server is silent until someone turns discovery on: on a desktop, Settings → the server → Access &amp; pairing → Discovery; on a headless host, <code>ion studio install --discoverable</code>.</Muted>
      <DataList
        label="Nearby servers"
        items={servers ?? []}
        loading={servers === null}
        getKey={(s) => s.url}
        onRowClick={(s) => { if (!isKnown(s)) { setSelected(s); setError(null) } }}
        isMuted={isKnown}
        columns={[
          { id: 'name', render: (s) => <CellText>{s.label}</CellText> },
          { id: 'where', width: 'minmax(0, 1fr)', render: (s) => <CellText muted>{`${s.host}:${s.port}${s.serverVersion ? ` · ${s.serverVersion}` : ''}`}</CellText> },
          { id: 'state', render: (s) => isSelf(s) ? <Chip>this desktop</Chip> : isKnown(s) ? <Chip>already added</Chip> : selected?.url === s.url ? <Chip tone="accent">selected</Chip> : null },
        ]}
        empty={<EmptyState icon={MagnifyingGlass} title="Nothing is discoverable on this network right now." />}
      />
      {selected && (
        <Field label={`Code for ${selected.label}`}>
          <TextInput aria-label="Pairing code" mono placeholder="Code shown on the server, e.g. ABCD-EFGH" value={code} onChange={(e) => { setCode(e.target.value); setError(null) }} />
        </Field>
      )}
      <ErrorText>{error}</ErrorText>
    </Stack>
  )
  const actions = <>
    <Button disabled={servers === null || pairing} onClick={search}>Search again</Button>
    <Button variant="primary" disabled={!selected || code.trim().length < 8 || pairing} onClick={() => { void pair() }}>{pairing ? 'Pairing…' : 'Pair'}</Button>
  </>
  return { body, actions, busy: pairing }
}
