import React, { useState, useCallback } from 'react'
import { Trash, Plus, MagnifyingGlass, ArrowClockwise, PencilSimple, FloppyDisk, X, CircleNotch } from '@phosphor-icons/react'
import { useColors } from '../../theme'

export interface DiscoveredRelay {
  id: string
  name: string
  host: string
  port: number
  addresses: string[]
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
    setIsEditingRelay(true)
  }

  const handleCancelEdit = () => {
    setIsEditingRelay(false)
    setIsDiscovering(false)
    window.ion?.remoteStopDiscovery?.()
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
