/**
 * DiscoverySection — whether this server announces itself on its LAN, and
 * the one-time code a desktop types to pair with it.
 *
 * Off by default. On a desktop a person opens a bounded window that shuts
 * itself off; the live code is shown while it is open and is replaced after
 * each use. A headless host announces continuously when its server.json
 * says so, which is changed by redeploying it, so this section only shows
 * that state and mints a code on request. When the organization has sealed
 * LAN discovery the section says so and offers nothing: pairing then goes
 * through a pairing link.
 */
import React, { useEffect, useState } from 'react'
import type { EnvironmentDiscoveryStatus } from '@ion/shared/types-environment-admin'
import { DISCOVERY_CHANNEL } from '@ion/shared/types-environment-admin'
import { environmentClient, useEnvironmentResource, onEnvironmentEvent } from '../../environment/environment-client'
import { useSettingsEnvironment } from '../../settings-servers'
import { Button, Chip, ErrorText, FormGroup, FormRow, Muted } from '../../kit'
import { CodeText, remaining } from './access-parts'
import { rInfo, rWarn } from '../../../../rendererLogger'

const WINDOWS: Array<{ minutes: number; label: string }> = [{ minutes: 15, label: '15 minutes' }, { minutes: 60, label: '1 hour' }]

export function DiscoverySection(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const status = useEnvironmentResource(env.id, environmentClient.discoveryStatus)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [standalone, setStandalone] = useState<{ code: string; expiresAt: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // The server announces every change (a window closing itself included).
  useEffect(() => onEnvironmentEvent(env.id, DISCOVERY_CHANNEL, () => status.refresh()), [env.id, status])
  const until = status.data?.until ?? null
  useEffect(() => {
    if (until === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [until])

  const run = (what: string, fn: () => Promise<unknown>): void => {
    setBusy(true); setError(null)
    fn().then(() => { rInfo('discovery-section', 'discovery action done', { action: what, environment_id: env.id }); status.refresh() }).catch((err: unknown) => {
      rWarn('discovery-section', 'discovery action failed', { action: what, environment_id: env.id, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setBusy(false))
  }

  const data: EnvironmentDiscoveryStatus | null = status.data ?? null
  return (
    <FormGroup
      title="Discovery"
      anchor="discovery"
      description={`Whether ${env.label} announces itself on its local network, so a desktop can find it under Add Environment → Nearby. Finding it grants nothing: pairing still needs the code shown here.`}
    >
      {!data && <FormRow label="Discoverable" description={status.error ?? (status.loading ? 'Checking…' : undefined)} />}
      {data?.mode === 'sealed' && (
        <FormRow label="LAN discovery" description="Your organization has turned LAN discovery off. Pair other devices with a pairing link from Devices instead." />
      )}
      {data?.mode === 'off' && (
        <FormRow label="Discoverable" description={<>Make it discoverable for a while so a desktop nearby can find it.<ErrorText>{error}</ErrorText></>}>
          <Chip>not discoverable</Chip>
          {WINDOWS.map((w) => <Button key={w.minutes} disabled={busy} onClick={() => run('window opened', () => environmentClient.discoveryOpen(env.id, w.minutes))}>{w.label}</Button>)}
        </FormRow>
      )}
      {data?.mode === 'window' && (
        <FormRow label="Discoverable" description={<>{data.until !== null && `turns itself off in ${remaining(data.until, now)}`}<ErrorText>{error}</ErrorText></>}>
          <Chip tone="ok">discoverable</Chip>
          <Button disabled={busy} onClick={() => run('window closed', () => environmentClient.discoveryClose(env.id))}>Turn off now</Button>
        </FormRow>
      )}
      {data?.mode === 'window' && (
        <FormRow label="Pairing code" description="Type this code on the other desktop under Add Environment → Nearby. It pairs one device, then a new code appears here.">
          {data.code ? <CodeText testId="discovery-code">{data.code}</CodeText> : <Muted>No code yet</Muted>}
        </FormRow>
      )}
      {data?.mode === 'persistent' && (
        <FormRow label="Discoverable" description={<>Set in this host&apos;s server.json; change it by redeploying.<ErrorText>{error}</ErrorText></>}>
          <Chip tone="ok">always discoverable</Chip>
          {standalone && <CodeText testId="discovery-code">{standalone.code}</CodeText>}
          <Button disabled={busy} onClick={() => run('code minted', async () => { setStandalone(await environmentClient.discoveryMintCode(env.id)) })}>Show a code</Button>
        </FormRow>
      )}
    </FormGroup>
  )
}
