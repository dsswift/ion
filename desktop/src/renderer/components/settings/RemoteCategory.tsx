import React, { useState, useEffect, useCallback } from 'react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { SettingToggle } from './SettingToggle'
import { SettingHeading } from './SettingHeading'
import { RemoteCategoryDevices } from './RemoteCategoryDevices'
import { RemoteCategoryRelay, type DiscoveredRelay } from './RemoteCategoryRelay'
import type { RemotePairedDevice, RemoteTransportState } from '../../../shared/types'

export function RemoteCategory() {
  const colors = useColors()
  const remoteEnabled = usePreferencesStore((s) => s.remoteEnabled)
  const setRemoteEnabled = usePreferencesStore((s) => s.setRemoteEnabled)
  const relayUrl = usePreferencesStore((s) => s.relayUrl)
  const setRelayUrl = usePreferencesStore((s) => s.setRelayUrl)
  const relayApiKey = usePreferencesStore((s) => s.relayApiKey)
  const setRelayApiKey = usePreferencesStore((s) => s.setRelayApiKey)
  const pairedDevices = usePreferencesStore((s) => s.pairedDevices)
  const removePairedDevice = usePreferencesStore((s) => s.removePairedDevice)
  const addPairedDevice = usePreferencesStore((s) => s.addPairedDevice)

  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [transportState, setTransportState] = useState<RemoteTransportState>('disconnected')
  const [discoveredRelays, setDiscoveredRelays] = useState<DiscoveredRelay[]>([])
  const [isDiscovering, setIsDiscovering] = useState(false)

  // Debug: temporarily disable LAN server (not persisted, resets on restart)
  const [lanDisabled, setLanDisabled] = useState(false)
  const handleToggleLan = useCallback((disabled: boolean) => {
    setLanDisabled(disabled)
    window.ion?.remoteSetLanDisabled?.(disabled)
  }, [])

  // Listen for remote state changes from main process.
  useEffect(() => {
    const handler = (_e: unknown, state: { transportState: RemoteTransportState }) => {
      setTransportState(state.transportState)
    }
    window.ion?.on?.('ion:remote-state-changed', handler)
    // Load initial state.
    window.ion?.remoteGetState?.().then((state: { transportState: RemoteTransportState } | null) => {
      if (state) setTransportState(state.transportState)
    })
    return () => {
      window.ion?.off?.('ion:remote-state-changed', handler)
    }
  }, [])

  // Listen for successful pairing from main process.
  useEffect(() => {
    const handler = (_e: unknown, device: RemotePairedDevice) => {
      addPairedDevice(device)
      setPairingCode(null)
    }
    window.ion?.on?.('ion:remote-device-paired', handler)
    return () => {
      window.ion?.off?.('ion:remote-device-paired', handler)
    }
  }, [addPairedDevice])

  // Listen for remote-initiated device revocation (e.g. iOS unpaired).
  useEffect(() => {
    const handler = (_e: unknown, deviceId: string) => {
      removePairedDevice(deviceId)
    }
    window.ion?.on?.('ion:remote-device-revoked', handler)
    return () => {
      window.ion?.off?.('ion:remote-device-revoked', handler)
    }
  }, [removePairedDevice])

  // Listen for relay discovery updates.
  useEffect(() => {
    const handler = (_e: unknown, relays: DiscoveredRelay[]) => {
      setDiscoveredRelays(relays)
    }
    window.ion?.on?.('ion:remote-relays-changed', handler)
    return () => {
      window.ion?.off?.('ion:remote-relays-changed', handler)
      window.ion?.remoteStopDiscovery?.()
    }
  }, [])

  const handleStartPairing = async () => {
    try {
      const code = await window.ion?.remoteStartPairing?.()
      if (code) setPairingCode(code)
    } catch (err) {
      console.error('[Remote] pairing failed:', err)
    }
  }

  const handleCancelPairing = () => {
    window.ion?.remoteCancelPairing?.()
    setPairingCode(null)
  }

  const handleRevokeDevice = (deviceId: string) => {
    removePairedDevice(deviceId)
    window.ion?.remoteRevokeDevice?.(deviceId)
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

  return (
    <>
      <SettingHeading first>Remote Control</SettingHeading>

      <SettingToggle
        label="Enable Remote Control"
        description="Allow the iOS companion app to control Ion remotely."
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
          <RemoteCategoryDevices
            pairedDevices={pairedDevices}
            pairingCode={pairingCode}
            onRevokeDevice={handleRevokeDevice}
            onStartPairing={handleStartPairing}
            onCancelPairing={handleCancelPairing}
          />

          {/* ── Relay Server ── */}
          <SettingHeading>Relay Server</SettingHeading>
          <RemoteCategoryRelay
            relayUrl={relayUrl}
            relayApiKey={relayApiKey}
            setRelayUrl={setRelayUrl}
            setRelayApiKey={setRelayApiKey}
            discoveredRelays={discoveredRelays}
            setDiscoveredRelays={setDiscoveredRelays}
            isDiscovering={isDiscovering}
            setIsDiscovering={setIsDiscovering}
          />

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
