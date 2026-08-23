import React, { useState, useCallback, useEffect } from 'react'
import { Trash, Plus, MagnifyingGlass, ArrowClockwise, PencilSimple, FloppyDisk, X, CircleNotch, CheckCircle } from '@phosphor-icons/react'
import { OidcAuthPanel } from './OidcAuthPanel'
import { useColors } from '../../theme'
import { rError, rInfo } from '../../rendererLogger'

export interface DiscoveredRelay {
  id: string
  name: string
  host: string
  port: number
  addresses: string[]
}

interface RelayAuthConfig {
  oidc: boolean
  issuer: string
  audience: string
  requiredScope: string
  psk: boolean
}

interface Props {
  relayUrl: string
  relayApiKey: string
  setRelayUrl: (url: string) => void
  setRelayApiKey: (key: string) => void
  /** Discovered relays from the LAN scan (provided by parent). */
  discoveredRelays: DiscoveredRelay[]
  setDiscoveredRelays: (r: DiscoveredRelay[]) => void
  isDiscovering: boolean
  setIsDiscovering: (v: boolean) => void
}

/** Relay server config + LAN discovery panel. */
export function RemoteCategoryRelay({
  relayUrl,
  relayApiKey,
  setRelayUrl,
  setRelayApiKey,
  discoveredRelays,
  setDiscoveredRelays,
  isDiscovering,
  setIsDiscovering,
}: Props) {
  const colors = useColors()

  // Edit-mode local state
  const [isEditingRelay, setIsEditingRelay] = useState(false)
  const [editUrl, setEditUrl] = useState('')
  const [editApiKey, setEditApiKey] = useState('')
  const [isTesting, setIsTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  // OIDC probe state (populated after URL entry)
  const [authConfig, setAuthConfig] = useState<RelayAuthConfig | null>(null)
  const [isProbing, setIsProbing] = useState(false)
  const [signedInUser, setSignedInUser] = useState<string | null>(null)
  const [isSigningIn, setIsSigningIn] = useState(false)

  // Probe auth config when URL changes and is non-empty.
  useEffect(() => {
    const url = editUrl.trim()
    if (!url || !isEditingRelay) {
      setAuthConfig(null)
      setSignedInUser(null)
      return
    }

    let cancelled = false
    setIsProbing(true)

    void (async () => {
      try {
        const cfg = await window.ion?.remoteRelayAuthConfig?.(url)
        if (cancelled) return
        setAuthConfig(cfg ?? null)

        if (cfg?.oidc) {
          // Check signed-in identity.
          const idResult = await window.ion?.entraIdentity?.()
          if (!cancelled) {
            setSignedInUser(idResult?.identity?.username ?? null)
          }
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
  }, [editUrl, isEditingRelay])

  // Display mode needs the same OIDC context as edit mode so the operator can
  // see the desktop's own relay identity without opening the editor.
  useEffect(() => {
    if (!relayUrl || isEditingRelay) return
    let cancelled = false
    void (async () => {
      try {
        const cfg = await window.ion?.remoteRelayAuthConfig?.(relayUrl)
        if (cancelled) return
        setAuthConfig(cfg ?? null)
        if (cfg?.oidc) {
          const identity = await window.ion?.entraIdentity?.()
          if (cancelled) return
          setSignedInUser(identity?.identity?.username ?? null)
        } else if (!cancelled) {
          setSignedInUser(null)
        }
      } catch (err) {
        if (!cancelled) rError('settings', 'load relay identity failed', { error: String(err) })
      }
    })()
    return () => { cancelled = true }
  }, [relayUrl, isEditingRelay])

  const handleDiscover = useCallback(async () => {
    setIsDiscovering(true)
    setDiscoveredRelays([])
    const relays = await window.ion?.remoteDiscoverRelays?.()
    if (relays) setDiscoveredRelays(relays)
  }, [setIsDiscovering, setDiscoveredRelays])

  const handleStopDiscovery = useCallback(() => {
    setIsDiscovering(false)
    window.ion?.remoteStopDiscovery?.()
    setDiscoveredRelays([])
  }, [setIsDiscovering, setDiscoveredRelays])

  const handleSelectRelay = useCallback((relay: DiscoveredRelay) => {
    const addr = relay.addresses.find((a) => !a.includes(':')) || relay.host
    setEditUrl(`ws://${addr}:${relay.port}`)
    setIsDiscovering(false)
    window.ion?.remoteStopDiscovery?.()
    setDiscoveredRelays([])
  }, [setIsDiscovering, setDiscoveredRelays])

  const handleEditRelay = () => {
    setEditUrl(relayUrl)
    setEditApiKey(relayApiKey)
    setTestError(null)
    setAuthConfig(null)
    setSignedInUser(null)
    setIsEditingRelay(true)
  }

  const handleCancelEdit = () => {
    setIsEditingRelay(false)
    setIsDiscovering(false)
    window.ion?.remoteStopDiscovery?.()
    setDiscoveredRelays([])
    setTestError(null)
    setAuthConfig(null)
    setSignedInUser(null)
  }

  const handleEnterpriseSignIn = async () => {
    setIsSigningIn(true)
    setTestError(null)
    try {
      const result = await window.ion?.entraSignIn?.()
      if (result?.ok && result.identity) {
        setSignedInUser(result.identity.username)
        rInfo('settings', 'relay enterprise sign-in succeeded', { user: result.identity.username })
      } else {
        setTestError(result?.error ?? 'Sign-in failed')
      }
    } catch (err) {
      setTestError((err as Error).message)
    } finally {
      setIsSigningIn(false)
    }
  }

  const handleOidcConnect = async () => {
    if (!signedInUser) return
    const url = editUrl.trim()
    setRelayUrl(url)
    // In OIDC mode, relayApiKey is empty (token is minted dynamically).
    setRelayApiKey('')
    setIsEditingRelay(false)
    setIsDiscovering(false)
    window.ion?.remoteStopDiscovery?.()
    setDiscoveredRelays([])
    setAuthConfig(null)
    setSignedInUser(null)
  }

  const handleTestAndSave = async () => {
    const url = editUrl.trim()
    const key = editApiKey.trim()
    if (!url) {
      setTestError('Relay URL is required')
      return
    }
    setIsTesting(true)
    setTestError(null)
    try {
      const result = await window.ion?.remoteTestRelay?.(url, key)
      if (result?.success) {
        setRelayUrl(url)
        setRelayApiKey(key)
        setIsEditingRelay(false)
        setIsDiscovering(false)
        window.ion?.remoteStopDiscovery?.()
        setDiscoveredRelays([])
      } else {
        setTestError(result?.error || 'Connection failed')
      }
    } catch (err) {
      setTestError((err as Error).message)
    } finally {
      setIsTesting(false)
    }
  }

  const handleDeleteRelay = () => {
    setRelayUrl('')
    setRelayApiKey('')
    setIsEditingRelay(false)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    background: colors.surfacePrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 8,
    padding: '8px 12px',
    color: colors.textPrimary,
    fontSize: 13,
    fontFamily: 'monospace',
    outline: 'none',
  }

  const smallBtnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '6px 12px',
    borderRadius: 8,
    fontSize: 12,
    cursor: 'pointer',
    border: 'none',
  }

  if (isEditingRelay) {
    // Determine what the action panel shows based on auth config probe.
    const isOidc = authConfig?.oidc === true
    const isPsk = !isOidc

    return (
      <div style={{
        background: colors.surfacePrimary,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 12,
        padding: 14,
      }}>
        <div style={{ marginBottom: 10 }}>
          <label style={{ color: colors.textSecondary, fontSize: 12, display: 'block', marginBottom: 4 }}>
            Relay URL
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <input
              type="text"
              value={editUrl}
              onChange={(e) => { setEditUrl(e.target.value); setTestError(null) }}
              placeholder="ws://relay.example.com:8080"
              style={inputStyle}
            />
            <button
              onClick={isDiscovering ? handleStopDiscovery : handleDiscover}
              title={isDiscovering ? 'Stop discovery' : 'Discover relays on your network'}
              style={{
                background: isDiscovering ? colors.accent : 'transparent',
                border: `1px solid ${isDiscovering ? colors.accent : colors.containerBorder}`,
                borderRadius: 8,
                padding: '8px 10px',
                cursor: 'pointer',
                color: isDiscovering ? colors.textOnAccent : colors.textSecondary,
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              {isDiscovering ? <ArrowClockwise size={16} /> : <MagnifyingGlass size={16} />}
            </button>
          </div>

          {/* Discovery results */}
          {isDiscovering && (
            <div style={{ marginTop: 8 }}>
              {discoveredRelays.length === 0 ? (
                <div style={{
                  color: colors.textTertiary,
                  fontSize: 11,
                  padding: '6px 0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}>
                  <ArrowClockwise size={12} style={{ animation: 'spin 1s linear infinite' }} />
                  Searching for relays on your network...
                </div>
              ) : (
                discoveredRelays.map((relay) => (
                  <button
                    key={relay.id}
                    onClick={() => handleSelectRelay(relay)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '6px 10px',
                      background: 'transparent',
                      border: `1px solid ${colors.containerBorder}`,
                      borderRadius: 8,
                      marginBottom: 4,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <div style={{
                      width: 8, height: 8, borderRadius: 4,
                      background: colors.statusComplete,
                      flexShrink: 0,
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: colors.textPrimary, fontSize: 12, fontWeight: 500 }}>
                        {relay.name}
                      </div>
                      <div style={{ color: colors.textTertiary, fontSize: 11 }}>
                        {relay.host}:{relay.port}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Probing indicator */}
        {isProbing && editUrl.trim() && (
          <div style={{ color: colors.textTertiary, fontSize: 11, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
            <CircleNotch size={12} style={{ animation: 'spin 1s linear infinite' }} />
            Checking relay auth mode...
          </div>
        )}

        {/* PSK mode: show API key field */}
        {isPsk && !isProbing && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ color: colors.textSecondary, fontSize: 12, display: 'block', marginBottom: 4 }}>
              API Key
            </label>
            <input
              type="password"
              value={editApiKey}
              onChange={(e) => { setEditApiKey(e.target.value); setTestError(null) }}
              placeholder="Shared secret for relay authentication"
              style={inputStyle}
            />
          </div>
        )}

        {/* OIDC mode: enterprise auth panel */}
        {isOidc && !isProbing && (
          <OidcAuthPanel
            signedInUser={signedInUser}
            isSigningIn={isSigningIn}
            onSignIn={() => { void handleEnterpriseSignIn().catch((err) => rError('settings', 'enterprise sign-in failed', { error: String(err) })) }}
            colors={colors}
          />
        )}

        {/* Test error */}
        {testError && (
          <div style={{
            color: colors.statusError,
            fontSize: 12,
            marginBottom: 10,
            padding: '6px 10px',
            background: `${colors.statusError}15`,
            borderRadius: 6,
          }}>
            {testError}
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
          {isOidc && !isProbing ? (
            <button
              onClick={() => { void handleOidcConnect().catch((err) => rError('settings', 'oidc connect failed', { error: String(err) })) }}
              disabled={!signedInUser}
              style={{
                ...smallBtnStyle,
                background: signedInUser ? colors.accent : colors.surfacePrimary,
                color: signedInUser ? colors.textOnAccent : colors.textTertiary,
                border: signedInUser ? 'none' : `1px solid ${colors.containerBorder}`,
                opacity: signedInUser ? 1 : 0.6,
              }}
            >
              <CheckCircle size={14} />
              Connect
            </button>
          ) : (
            <button
              onClick={() => { void handleTestAndSave().catch((err) => rError('settings', 'relay test and save failed', { error: String(err) })) }}
              disabled={isTesting || isProbing}
              style={{
                ...smallBtnStyle,
                background: colors.accent,
                color: colors.textOnAccent,
                opacity: isTesting || isProbing ? 0.7 : 1,
              }}
            >
              {isTesting ? (
                <CircleNotch size={14} style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <FloppyDisk size={14} />
              )}
              {isTesting ? 'Testing...' : 'Test & Save'}
            </button>
          )}
          <button
            onClick={handleCancelEdit}
            disabled={isTesting || isSigningIn}
            style={{
              ...smallBtnStyle,
              background: 'transparent',
              border: `1px solid ${colors.containerBorder}`,
              color: colors.textSecondary,
            }}
          >
            <X size={14} />
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // Display mode
  return (
    <>
      {relayUrl ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: colors.surfacePrimary,
          border: `1px solid ${colors.containerBorder}`,
          borderRadius: 8,
          marginBottom: 8,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: colors.textPrimary, fontSize: 13, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {relayUrl}
            </div>
            {authConfig?.oidc && (
              <div style={{ color: colors.textTertiary, fontSize: 11, marginTop: 2 }}>
                Desktop relay identity: {signedInUser ?? 'not signed in'} · {authConfig.issuer}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8 }}>
            <button
              onClick={handleEditRelay}
              title="Edit relay configuration"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: colors.textSecondary,
                padding: 4,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <PencilSimple size={16} />
            </button>
            <button
              onClick={handleDeleteRelay}
              title="Remove relay server"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: colors.statusError,
                padding: 4,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Trash size={16} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <p style={{ color: colors.textTertiary, fontSize: 12, margin: '0 0 10px' }}>
            No relay server configured. LAN only.
          </p>
          <button
            onClick={handleEditRelay}
            style={{
              ...smallBtnStyle,
              background: colors.surfacePrimary,
              border: `1px solid ${colors.containerBorder}`,
              color: colors.textSecondary,
            }}
          >
            <Plus size={14} />
            Add Relay Server
          </button>
        </>
      )}
    </>
  )
}
