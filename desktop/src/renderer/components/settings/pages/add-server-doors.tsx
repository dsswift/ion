/**
 * add-server-doors — the Pairing link, SSH, and Sign in doors of the Add
 * server panel. Each door is a hook returning its fields and its footer
 * buttons, so the panel can pin the buttons to its footer while the door
 * keeps its own state.
 *
 *  - Pairing link: paste the `ion-studio://pair?...` link a server minted.
 *    The host runs the key exchange and returns the `paired` target; the
 *    shared secret never enters the renderer.
 *  - SSH: type `user@host`. The host installs the Studio server there,
 *    tunnels to it, and pairs through the tunnel; progress lines stream in
 *    while it runs.
 *  - Sign in: probes `<url>/auth/config`; on failure offers manual OIDC
 *    fields.
 */
import React, { useEffect, useRef, useState } from 'react'
import { parsePairingLink, describePairingLinkFailure } from '@ion/shared/pairing-link'
import type { EnvironmentTarget } from '@ion/shared/types-environments'
import type { SshAddEnvironmentProgress } from '@ion/shared/types-ssh-environment'
import { probeAuthConfig, type AuthConfigProbeResult } from '../../../studio/connection/auth-config'
import { host } from '../../../host/host-instance'
import { rInfo, rWarn } from '../../../rendererLogger'
import { useColors } from '../../../theme'
import { Button, ErrorText, Field, KIT, Muted, Stack, TextArea, TextInput, toneColor } from '../kit'

/** A door's fields, its footer buttons, and whether it is mid-flight. */
export interface DoorView {
  body: React.ReactNode
  actions: React.ReactNode
  busy: boolean
}

export interface DoorProps {
  label: string
  setLabel(next: string): void
  onAdd(target: EnvironmentTarget): void
}

const TAG = 'settings.add-environment'

export function usePairDoor({ label, setLabel, onAdd }: DoorProps): DoorView {
  const colors = useColors()
  const [link, setLink] = useState('')
  const [pairing, setPairing] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)
  const parsedLink = link.trim() ? parsePairingLink(link) : null
  const linkHint = parsedLink && !parsedLink.ok ? describePairingLinkFailure(parsedLink.reason) : null

  const handlePair = async (): Promise<void> => {
    if (!parsedLink?.ok) return
    setPairing(true)
    setPairError(null)
    rInfo(TAG, 'pairing requested', { url: parsedLink.link.url })
    const result = await host.pairEnvironment(link, label.trim() || undefined)
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
    setPairing(false)
    if (!result.ok) {
      rWarn(TAG, 'pairing failed', { url: parsedLink.link.url, error: result.error })
      setPairError(result.error)
      return
    }
    rInfo(TAG, 'paired', { url: parsedLink.link.url, label: result.target.kind !== 'local' ? result.target.label : undefined })
    onAdd(result.target)
  }

  const body = (
    <Stack>
      <Muted>Paste the pairing link the server minted. On a headless server: <code>node dist/pair.js --label &quot;this laptop&quot;</code>.</Muted>
      <Field label="Pairing link">
        <TextArea
          aria-label="Pairing link"
          mono
          rows={3}
          placeholder="ion-studio://pair?code=…&url=http://server.local:7331&env=…"
          value={link}
          onChange={(e) => { setLink(e.target.value); setPairError(null) }}
        />
      </Field>
      {parsedLink?.ok && (
        <span style={{ fontSize: KIT.fontSmall, color: toneColor(colors, 'ok') }}>
          Server {parsedLink.link.label ? `“${parsedLink.link.label}” ` : ''}at {parsedLink.link.url}
          {parsedLink.link.relay ? ` · can also pair through the relay ${parsedLink.link.relay.url}` : ''}
        </span>
      )}
      <ErrorText>{linkHint}</ErrorText>
      <Field label="Label">
        <TextInput aria-label="Label" placeholder={parsedLink?.ok && parsedLink.link.label ? `Default: ${parsedLink.link.label}` : 'Label'} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <ErrorText>{pairError}</ErrorText>
    </Stack>
  )
  const actions = <Button variant="primary" disabled={!parsedLink?.ok || pairing} onClick={() => { void handlePair() }}>{pairing ? 'Pairing…' : 'Pair'}</Button>
  return { body, actions, busy: pairing }
}

export function useSshDoor({ label, setLabel, onAdd }: DoorProps): DoorView {
  const colors = useColors()
  const [sshDestination, setSshDestination] = useState('')
  const [sshBusy, setSshBusy] = useState(false)
  const [sshError, setSshError] = useState<string | null>(null)
  const [sshLog, setSshLog] = useState<SshAddEnvironmentProgress[]>([])
  const sshLogEnd = useRef<HTMLDivElement | null>(null)

  // Progress arrives on a broadcast channel; only lines for the destination
  // this panel asked about are shown (another window could be adding one).
  useEffect(() => {
    if (!sshBusy) return
    const wanted = sshDestination.trim()
    return host.onSshProgress((progress) => {
      if (progress.destination !== wanted) return
      setSshLog((prev) => [...prev, progress])
    })
  }, [sshBusy, sshDestination])
  useEffect(() => { sshLogEnd.current?.scrollIntoView?.({ block: 'end' }) }, [sshLog.length])

  const handleSsh = async (): Promise<void> => {
    const destination = sshDestination.trim()
    if (!destination) return
    setSshBusy(true)
    setSshError(null)
    setSshLog([])
    rInfo(TAG, 'ssh add requested', { destination })
    const result = await host.sshAddEnvironment(destination, label.trim() || undefined)
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
    setSshBusy(false)
    if (!result.ok) {
      rWarn(TAG, 'ssh add failed', { destination, error: result.error })
      setSshError(result.error)
      return
    }
    rInfo(TAG, 'ssh environment added', { destination, label: result.target.label })
    onAdd(result.target)
  }

  const body = (
    <Stack>
      <Muted>A Mac or Linux host you can reach with key-based SSH. Ion installs the Studio server there as a service, tunnels to it, and pairs this desktop. Nothing else to set up.</Muted>
      <Field label="Destination">
        <TextInput
          aria-label="SSH destination"
          mono
          placeholder="user@host   (or host:2222, or an ~/.ssh/config alias)"
          value={sshDestination}
          disabled={sshBusy}
          onChange={(e) => { setSshDestination(e.target.value); setSshError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !sshBusy) void handleSsh() }}
        />
      </Field>
      <Field label="Label">
        <TextInput aria-label="Label" placeholder="Default: the host name" value={label} disabled={sshBusy} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      {sshLog.length > 0 && (
        <div role="log" aria-label="SSH setup progress" style={{ maxHeight: 180, overflowY: 'auto', padding: '6px 8px', borderRadius: KIT.radius, background: colors.surfaceSecondary, fontSize: KIT.fontTiny, fontFamily: KIT.mono, color: colors.textSecondary }}>
          {sshLog.map((p, i) => (
            <div key={i} style={{ color: p.stage === 'failed' ? toneColor(colors, 'error') : p.stage === 'done' ? toneColor(colors, 'ok') : undefined, whiteSpace: 'pre-wrap' }}>{p.message}</div>
          ))}
          <div ref={sshLogEnd} />
        </div>
      )}
      {sshError && <ErrorText><span style={{ whiteSpace: 'pre-wrap' }}>{sshError}</span></ErrorText>}
    </Stack>
  )
  const actions = <Button variant="primary" disabled={!sshDestination.trim() || sshBusy} onClick={() => { void handleSsh() }}>{sshBusy ? 'Setting up…' : 'Add'}</Button>
  return { body, actions, busy: sshBusy }
}

export function useSignInDoor({ label, setLabel, onAdd }: DoorProps): DoorView {
  const colors = useColors()
  const [url, setUrl] = useState('')
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<AuthConfigProbeResult | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [issuer, setIssuer] = useState('')
  const [audience, setAudience] = useState('')
  const [scope, setScope] = useState('')

  const handleProbe = async (): Promise<void> => {
    setProbing(true)
    const result = await probeAuthConfig(url)
    setProbing(false)
    if (result) {
      rInfo(TAG, 'auth config probed', { url, environment_id: result.environmentId })
      setProbeResult(result)
      setLabel(result.label)
      setAdvanced(false)
    } else {
      rWarn(TAG, 'auth config probe failed; manual fields shown', { url })
      setProbeResult(null)
      setAdvanced(true)
    }
  }

  const handleSaveBearer = (): void => {
    const oidc = probeResult?.oidc ?? (issuer && audience && scope ? { issuer, audience, scope } : undefined)
    const target: EnvironmentTarget = { kind: 'bearer', label: label || url, url, oidc, environmentId: probeResult?.environmentId }
    rInfo(TAG, 'sign-in server saved', { url, has_oidc: oidc !== undefined })
    onAdd(target)
  }

  const body = (
    <Stack>
      <Field label="Server URL">
        <div style={{ display: 'flex', gap: 6 }}>
          <TextInput aria-label="Server URL" placeholder="https://ion.example.com" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
          <Button disabled={!url || probing} onClick={() => { void handleProbe() }}>{probing ? 'Checking…' : 'Test'}</Button>
        </div>
      </Field>
      {probeResult && <span style={{ fontSize: KIT.fontSmall, color: toneColor(colors, 'ok') }}>Found {probeResult.label} (protocol v{probeResult.protocolVersion})</span>}
      {advanced && <>
        <Muted>Could not reach /auth/config. Enter the details by hand:</Muted>
        <Field label="OIDC issuer"><TextInput aria-label="OIDC issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} /></Field>
        <Field label="Audience"><TextInput aria-label="Audience" value={audience} onChange={(e) => setAudience(e.target.value)} /></Field>
        <Field label="Scope"><TextInput aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)} /></Field>
      </>}
      <Field label="Label"><TextInput aria-label="Label" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
    </Stack>
  )
  const actions = <Button variant="primary" disabled={!url} onClick={handleSaveBearer}>Save</Button>
  return { body, actions, busy: probing }
}
