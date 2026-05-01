import React from 'react'
import { Trash, Plus } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import type { RemotePairedDevice } from '../../../shared/types'

interface Props {
  pairedDevices: RemotePairedDevice[]
  pairingCode: string | null
  onRevokeDevice: (deviceId: string) => void
  onStartPairing: () => void
  onCancelPairing: () => void
}

/** Paired devices list + pairing code panel. */
export function RemoteCategoryDevices({
  pairedDevices,
  pairingCode,
  onRevokeDevice,
  onStartPairing,
  onCancelPairing,
}: Props) {
  const colors = useColors()

  return (
    <>
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
            onClick={() => onRevokeDevice(device.id)}
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
            onClick={onCancelPairing}
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
          onClick={onStartPairing}
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
    </>
  )
}
