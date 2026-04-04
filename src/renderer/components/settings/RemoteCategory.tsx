import React, { useState, useEffect, useCallback } from 'react'
import { Trash, Plus, MagnifyingGlass, ArrowClockwise, PencilSimple, FloppyDisk, X, CircleNotch, Bug } from '@phosphor-icons/react'
import { useColors, useThemeStore } from '../../theme'
import { SettingToggle } from './SettingToggle'
import { SettingHeading } from './SettingHeading'
import type { RemotePairedDevice, RemoteTransportState } from '../../../shared/types'

interface DiscoveredRelay {
  id: string
  name: string
  host: string
  port: number
  addresses: string[]
}

export function RemoteCategory() {
  const colors = useColors()
  const remoteEnabled = useThemeStore((s) => s.remoteEnabled)
  const setRemoteEnabled = useThemeStore((s) => s.setRemoteEnabled)
  const relayUrl = useThemeStore((s) => s.relayUrl)
  const setRelayUrl = useThemeStore((s) => s.setRelayUrl)
  const relayApiKey = useThemeStore((s) => s.relayApiKey)
  const setRelayApiKey = useThemeStore((s) => s.setRelayApiKey)
  const pairedDevices = useThemeStore((s) => s.pairedDevices)
  const removePairedDevice = useThemeStore((s) => s.removePairedDevice)

  const addPairedDevice = useThemeStore((s) => s.addPairedDevice)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [transportState, setTransportState] = useState<RemoteTransportState>('disconnected')
  const [discoveredRelays, setDiscoveredRelays] = useState<DiscoveredRelay[]>([])
  const [isDiscovering, setIsDiscovering] = useState(false)

  // Relay edit mode state
  const [isEditingRelay, setIsEditingRelay] = useState(false)
  const [editUrl, setEditUrl] = useState('')
  const [editApiKey, setEditApiKey] = useState('')
  const [isTesting, setIsTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  // Debug: temporarily disable LAN server (not persisted, resets on restart)
  const [lanDisabled, setLanDisabled] = useState(false)
  const handleToggleLan = useCallback((disabled: boolean) => {
    setLanDisabled(disabled)
    window.coda?.remoteSetLanDisabled?.(disabled)
  }, [])

  // Listen for remote state changes from main process.
  useEffect(() => {
    const handler = (_e: unknown, state: { transportState: RemoteTransportState }) => {
      setTransportState(state.transportState)
    }
    window.coda?.on?.('coda:remote-state-changed', handler)
    // Load initial state.
    window.coda?.remoteGetState?.().then((state: { transportState: RemoteTransportState } | null) => {
      if (state) setTransportState(state.transportState)
    })
    return () => {
      window.coda?.off?.('coda:remote-state-changed', handler)
    }
  }, [])

  // Listen for successful pairing from main process.
  useEffect(() => {
    const handler = (_e: unknown, device: RemotePairedDevice) => {
      addPairedDevice(device)
      setPairingCode(null)
    }
    window.coda?.on?.('coda:remote-device-paired', handler)
    return () => {
      window.coda?.off?.('coda:remote-device-paired', handler)
    }
  }, [addPairedDevice])

  // Listen for remote-initiated device revocation (e.g. iOS unpaired).
  useEffect(() => {
    const handler = (_e: unknown, deviceId: string) => {
      removePairedDevice(deviceId)
    }
    window.coda?.on?.('coda:remote-device-revoked', handler)
    return () => {
      window.coda?.off?.('coda:remote-device-revoked', handler)
    }
  }, [removePairedDevice])

  // Listen for relay discovery updates.
  useEffect(() => {
    const handler = (_e: unknown, relays: DiscoveredRelay[]) => {
      setDiscoveredRelays(relays)
    }
    window.coda?.on?.('coda:remote-relays-changed', handler)
    return () => {
      window.coda?.off?.('coda:remote-relays-changed', handler)
      window.coda?.remoteStopDiscovery?.()
    }
  }, [])

  const handleDiscover = async () => {
    setIsDiscovering(true)
    setDiscoveredRelays([])
    const relays = await window.coda?.remoteDiscoverRelays?.()
    if (relays) setDiscoveredRelays(relays)
  }

  const handleStopDiscovery = () => {
    setIsDiscovering(false)
    window.coda?.remoteStopDiscovery?.()
    setDiscoveredRelays([])
  }

  const handleSelectRelay = (relay: DiscoveredRelay) => {
    const addr = relay.addresses.find((a) => !a.includes(':')) || relay.host
    setEditUrl(`ws://${addr}:${relay.port}`)
    setIsDiscovering(false)
    window.coda?.remoteStopDiscovery?.()
    setDiscoveredRelays([])
  }

  const handleStartPairing = async () => {
    try {
      const code = await window.coda?.remoteStartPairing?.()
      if (code) setPairingCode(code)
    } catch (err) {
      console.error('[Remote] pairing failed:', err)
    }
  }

  const handleCancelPairing = () => {
    window.coda?.remoteCancelPairing?.()
    setPairingCode(null)
  }

  const handleRevokeDevice = (deviceId: string) => {
    removePairedDevice(deviceId)
    window.coda?.remoteRevokeDevice?.(deviceId)
  }

  const handleEditRelay = () => {
    setEditUrl(relayUrl)
    setEditApiKey(relayApiKey)
    setTestError(null)
    setIsEditingRelay(true)
  }

  const handleCancelEdit = () => {
    setIsEditingRelay(false)
    setIsDiscovering(false)
    window.coda?.remoteStopDiscovery?.()
    setDiscoveredRelays([])
    setTestError(null)
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
      const result = await window.coda?.remoteTestRelay?.(url, key)
      if (result?.success) {
        setRelayUrl(url)
        setRelayApiKey(key)
        setIsEditingRelay(false)
        setIsDiscovering(false)
        window.coda?.remoteStopDiscovery?.()
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

  const statusLabel = (state: RemoteTransportState) => {
    switch (state) {
      case 'disconnected': return 'Disconnected'
      case 'relay_only': return 'Connected (Relay)'
      case 'lan_preferred': return 'Connected (LAN)'
    }
  }

  const statusColor = (state: RemoteTransportState) => {
    switch (state) {
      case 'disconnected': return colors.statusError
      case 'relay_only': return colors.statusComplete
      case 'lan_preferred': return colors.statusComplete
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
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

  return (
    <>
      <SettingHeading first>Remote Control</SettingHeading>

      <SettingToggle
        label="Enable Remote Control"
        description="Allow the iOS companion app to control CODA remotely."
        checked={remoteEnabled}
        onChange={setRemoteEnabled}
      />

      {remoteEnabled && (
        <>
          {/* Connection status */}
          <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 8, height: 8, borderRadius: 4,
              background: statusColor(transportState),
            }} />
            <span style={{ color: colors.textSecondary, fontSize: 12 }}>
              {statusLabel(transportState)}
            </span>
          </div>

          {/* ── Paired Devices (moved above relay) ── */}
          <SettingHeading>Paired Devices</SettingHeading>

          {pairedDevices.length === 0 && (
            <p style={{ color: colors.textTertiary, fontSize: 12, margin: '0 0 10px' }}>
              No paired devices. Pair your iPhone to get started.
            </p>
          )}

          {pairedDevices.map((device: RemotePairedDevice) => (
            <div
              key={device.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px',
                background: colors.surfacePrimary,
                borderRadius: 8,
                marginBottom: 6,
              }}
            >
              <div>
                <div style={{ color: colors.textPrimary, fontSize: 13, fontWeight: 500 }}>
                  {device.name}
                </div>
                <div style={{ color: colors.textTertiary, fontSize: 11 }}>
                  {device.lastSeen
                    ? `Last seen ${new Date(device.lastSeen).toLocaleDateString()}`
                    : `Paired ${new Date(device.pairedAt).toLocaleDateString()}`
                  }
                </div>
              </div>
              <button
                onClick={() => handleRevokeDevice(device.id)}
                title="Revoke device"
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
          ))}

          {/* Pairing */}
          {pairingCode ? (
            <div style={{
              padding: 16,
              background: colors.surfacePrimary,
              borderRadius: 12,
              textAlign: 'center',
              marginTop: 8,
            }}>
              <div style={{ color: colors.textTertiary, fontSize: 12, marginBottom: 8 }}>
                Enter this code on your iPhone
              </div>
              <div style={{
                color: colors.textPrimary,
                fontSize: 32,
                fontWeight: 700,
                fontFamily: 'monospace',
                letterSpacing: 8,
              }}>
                {pairingCode}
              </div>
              <button
                onClick={handleCancelPairing}
                style={{
                  marginTop: 12,
                  background: 'none',
                  border: `1px solid ${colors.containerBorder}`,
                  borderRadius: 8,
                  padding: '6px 16px',
                  color: colors.textSecondary,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={handleStartPairing}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 8,
                padding: '8px 16px',
                background: colors.accent,
                border: 'none',
                borderRadius: 8,
                color: '#fff',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              <Plus size={14} weight="bold" />
              Pair New Device
            </button>
          )}

          {/* ── Relay Server ── */}
          <SettingHeading>Relay Server</SettingHeading>

          {isEditingRelay ? (
            /* ── Edit mode ── */
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
                <div style={{ display: 'flex', gap: 6 }}>
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
                      color: isDiscovering ? '#fff' : colors.textSecondary,
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
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={handleTestAndSave}
                  disabled={isTesting}
                  style={{
                    ...smallBtnStyle,
                    background: colors.accent,
                    color: '#fff',
                    opacity: isTesting ? 0.7 : 1,
                  }}
                >
                  {isTesting ? (
                    <CircleNotch size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  ) : (
                    <FloppyDisk size={14} />
                  )}
                  {isTesting ? 'Testing...' : 'Test & Save'}
                </button>
                <button
                  onClick={handleCancelEdit}
                  disabled={isTesting}
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
          ) : (
            /* ── Display mode ── */
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
          )}

          {/* ── Debug: Disable LAN Server ── */}
          {relayUrl && (
            <>
              <SettingHeading>Debug</SettingHeading>
              <SettingToggle
                label="Disable LAN Server"
                description="Force relay-only mode. Resets on restart."
                checked={lanDisabled}
                onChange={handleToggleLan}
              />
            </>
          )}
        </>
      )}
    </>
  )
}
