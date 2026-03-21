import React from 'react'
import { X, FolderOpen, Trash } from '@phosphor-icons/react'
import { useColors, useThemeStore } from '../theme'

interface SettingsDialogProps {
  onClose: () => void
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const colors = useColors()
  const defaultBaseDirectory = useThemeStore((s) => s.defaultBaseDirectory)
  const setDefaultBaseDirectory = useThemeStore((s) => s.setDefaultBaseDirectory)

  const handleBrowse = async () => {
    const dir = await window.clui.selectDirectory()
    if (dir) {
      setDefaultBaseDirectory(dir)
    }
  }

  const handleClear = () => {
    setDefaultBaseDirectory('')
  }

  return (
    <div
      data-clui-ui
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px 10px',
          borderBottom: `1px solid ${colors.containerBorder}`,
        }}
      >
        <span style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600 }}>
          Settings
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: colors.textTertiary,
            padding: 4,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '16px', flex: 1, overflowY: 'auto' }}>
        {/* Default Base Directory */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              color: colors.textSecondary,
              fontSize: 12,
              fontWeight: 500,
              marginBottom: 8,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Default Base Directory
          </label>
          <p
            style={{
              color: colors.textTertiary,
              fontSize: 12,
              margin: '0 0 10px',
              lineHeight: 1.4,
            }}
          >
            New tabs will open in this directory. When empty, defaults to your home directory.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div
              style={{
                flex: 1,
                background: colors.surfacePrimary,
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 8,
                padding: '8px 12px',
                color: defaultBaseDirectory ? colors.textPrimary : colors.textTertiary,
                fontSize: 13,
                fontFamily: 'monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {defaultBaseDirectory || '~/'}
            </div>
            <button
              onClick={handleBrowse}
              title="Browse..."
              style={{
                background: colors.surfacePrimary,
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 8,
                padding: '8px 10px',
                cursor: 'pointer',
                color: colors.textSecondary,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              <FolderOpen size={15} />
              Browse
            </button>
            {defaultBaseDirectory && (
              <button
                onClick={handleClear}
                title="Reset to home directory"
                style={{
                  background: colors.surfacePrimary,
                  border: `1px solid ${colors.containerBorder}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  cursor: 'pointer',
                  color: colors.textTertiary,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <Trash size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
