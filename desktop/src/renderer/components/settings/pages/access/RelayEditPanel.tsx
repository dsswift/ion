/**
 * RelayEditPanel — adds or changes the relay server a server uses to
 * reach a phone off the LAN. It can look for relays on the local network,
 * asks the relay which auth it takes, and then either tests a shared key
 * (PSK) before saving or signs in with Microsoft Entra (OIDC) and connects.
 * An OIDC relay stores no key: the token is minted when the relay is used.
 */
import React, { useEffect, useState } from 'react'
import { MagnifyingGlass, X, SignIn, CheckCircle, FloppyDisk } from '@phosphor-icons/react'
import { IPC } from '@ion/shared/types'
import { Button, CellText, DataList, EmptyState, ErrorText, Field, Inline, Muted, Notice, SidePanel, Stack, StatusDot, TextInput } from '../../kit'
import { useSettingsShell } from '../../settings-shell'
import { rError, rInfo } from '../../../../rendererLogger'

export interface DiscoveredRelay {
  id: string
  name: string
  host: string
  port: number
  addresses: string[]
}

export interface RelayAuthConfig {
  oidc: boolean
  issuer: string
  audience: string
  requiredScope: string
  psk: boolean
}

export interface RelaySave {
  url: string
  apiKey: string
}

export function RelayEditPanel({ relayUrl, relayApiKey, onSave, onClose }: { relayUrl: string; relayApiKey: string; onSave(next: RelaySave): void; onClose(): void }): React.JSX.Element {
  const { shell, on } = useSettingsShell()
  const [editUrl, setEditUrl] = useState(relayUrl)
  const [editApiKey, setEditApiKey] = useState(relayApiKey)
  const [isTesting, setIsTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [authConfig, setAuthConfig] = useState<RelayAuthConfig | null>(null)
  const [isProbing, setIsProbing] = useState(false)
  const [signedInUser, setSignedInUser] = useState<string | null>(null)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredRelay[]>([])
  const [isDiscovering, setIsDiscovering] = useState(false)

  // Relay discovery results from the server being edited, and discovery
  // stopped there whenever the panel goes.
  useEffect(() => {
    const off = on(IPC.REMOTE_RELAYS_CHANGED, (payload) => setDiscovered(Array.isArray(payload) ? payload as DiscoveredRelay[] : []))
    return () => {
      off()
      shell.remoteStopDiscovery()
    }
  }, [shell, on])

  // Ask the relay which auth it takes whenever the URL changes.
  useEffect(() => {
    const url = editUrl.trim()
    if (!url) {
      setAuthConfig(null)
      setSignedInUser(null)
      setIsProbing(false)
      return
    }
    let cancelled = false
    setIsProbing(true)
    void (async () => {
      try {
        const cfg = await shell.remoteRelayAuthConfig(url)
        if (cancelled) return
        setAuthConfig(cfg ?? null)
        if (cfg?.oidc) {
          const idResult = await shell.entraIdentity()
          if (!cancelled) setSignedInUser(idResult?.identity?.username ?? null)
        } else {
          setSignedInUser(null)
        }
      } catch (err) {
        if (!cancelled) {
          rError('settings', 'relay auth config probe failed', { error: String(err) })
          setAuthConfig(null)
        }
      } finally {
        if (!cancelled) setIsProbing(false)
      }
    })()
    return () => { cancelled = true }
  }, [editUrl, shell])

  const stopDiscovery = (): void => {
    setIsDiscovering(false)
    shell.remoteStopDiscovery()
    setDiscovered([])
  }

  const discover = (): void => {
    setIsDiscovering(true)
    setDiscovered([])
    shell.remoteDiscoverRelays().then((relays) => { if (relays) setDiscovered(relays) })
      .catch((err: unknown) => rError('settings', 'relay discovery failed', { error: String(err) }))
  }

  const selectRelay = (relay: DiscoveredRelay): void => {
    const addr = relay.addresses.find((a) => !a.includes(':')) || relay.host
    setEditUrl(`ws://${addr}:${relay.port}`)
    stopDiscovery()
  }

  const signIn = async (): Promise<void> => {
    setIsSigningIn(true)
    setTestError(null)
    try {
      const result = await shell.entraSignIn()
      if (result?.ok && result.identity) {
        setSignedInUser(result.identity.username)
        rInfo('settings', 'relay enterprise sign-in succeeded', { signed_in_user: result.identity.username })
      } else {
        setTestError(result?.error ?? 'Sign-in failed')
      }
    } catch (err) {
      setTestError((err as Error).message)
    } finally {
      setIsSigningIn(false)
    }
  }

  const connectOidc = (): void => {
    if (!signedInUser) return
    stopDiscovery()
    // In OIDC mode the key stays empty: the token is minted dynamically.
    onSave({ url: editUrl.trim(), apiKey: '' })
  }

  const testAndSave = async (): Promise<void> => {
    const url = editUrl.trim()
    const key = editApiKey.trim()
    if (!url) {
      setTestError('Relay URL is required')
      return
    }
    setIsTesting(true)
    setTestError(null)
    try {
      const result = await shell.remoteTestRelay(url, key)
      if (result?.success) {
        stopDiscovery()
        onSave({ url, apiKey: key })
      } else {
        setTestError(result?.error || 'Connection failed')
      }
    } catch (err) {
      setTestError((err as Error).message)
    } finally {
      setIsTesting(false)
    }
  }

  const isOidc = authConfig?.oidc === true
  const probed = !isProbing
  return (
    <SidePanel
      open
      title={relayUrl ? 'Edit relay server' : 'Add relay server'}
      subtitle="A relay carries this server's traffic to a phone that is not on the same network."
      onClose={onClose}
      footer={<>
        <Button icon={X} disabled={isTesting || isSigningIn} onClick={onClose}>Cancel</Button>
        {isOidc && probed
          ? <Button variant="primary" icon={CheckCircle} disabled={!signedInUser} onClick={connectOidc}>Connect</Button>
          : <Button variant="primary" icon={FloppyDisk} disabled={isTesting || !probed} onClick={() => { void testAndSave().catch((err: unknown) => rError('settings', 'relay test and save failed', { error: String(err) })) }}>{isTesting ? 'Testing…' : 'Test & Save'}</Button>}
      </>}
    >
      <Stack>
        <Field label="Relay URL">
          <Inline>
            <TextInput mono aria-label="Relay URL" value={editUrl} placeholder="ws://relay.example.com:8080" onChange={(e) => { setEditUrl(e.target.value); setTestError(null) }} />
            <Button icon={MagnifyingGlass} variant={isDiscovering ? 'primary' : 'secondary'} tooltip={isDiscovering ? 'Stop discovery' : 'Discover relays on your network'} onClick={isDiscovering ? stopDiscovery : discover}>{isDiscovering ? 'Stop' : 'Discover'}</Button>
          </Inline>
        </Field>
        {isDiscovering && (
          <DataList
            label="Discovered relays"
            items={discovered}
            getKey={(r) => r.id}
            onRowClick={selectRelay}
            columns={[
              { id: 'name', render: (r) => <><StatusDot tone="ok" /><CellText>{r.name}</CellText></> },
              { id: 'host', render: (r) => <CellText mono muted>{`${r.host}:${r.port}`}</CellText> },
            ]}
            empty={<EmptyState title="Searching for relays on your network…" />}
          />
        )}
        {isProbing && <Muted>Checking relay auth mode…</Muted>}
        {!isOidc && probed && (
          <Field label="API Key">
            <TextInput type="password" aria-label="API Key" value={editApiKey} placeholder="Shared secret for relay authentication" onChange={(e) => { setEditApiKey(e.target.value); setTestError(null) }} />
          </Field>
        )}
        {isOidc && probed && (signedInUser
          ? <Notice tone="ok">Signed in as {signedInUser}. Enterprise relay auth ready.</Notice>
          : <Notice
              tone="accent"
              action={<Button variant="primary" icon={SignIn} disabled={isSigningIn} onClick={() => { void signIn().catch((err: unknown) => rError('settings', 'enterprise sign-in failed', { error: String(err) })) }}>{isSigningIn ? 'Signing in…' : 'Sign in with Microsoft'}</Button>}
            >
              Enterprise sign-in required. This relay uses Microsoft Entra identity. Sign in to connect.
            </Notice>)}
        <ErrorText>{testError}</ErrorText>
      </Stack>
    </SidePanel>
  )
}
