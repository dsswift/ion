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
  const showDirLabel = useThemeStore((s) => s.showDirLabel)
  const setShowDirLabel = useThemeStore((s) => s.setShowDirLabel)
  const showImplementClearContext = useThemeStore((s) => s.showImplementClearContext)
  const setShowImplementClearContext = useThemeStore((s) => s.setShowImplementClearContext)
  const defaultPermissionMode = useThemeStore((s) => s.defaultPermissionMode)
  const setDefaultPermissionMode = useThemeStore((s) => s.setDefaultPermissionMode)
  const expandOnTabSwitch = useThemeStore((s) => s.expandOnTabSwitch)
  const setExpandOnTabSwitch = useThemeStore((s) => s.setExpandOnTabSwitch)
  const bashCommandEntry = useThemeStore((s) => s.bashCommandEntry)
  const setBashCommandEntry = useThemeStore((s) => s.setBashCommandEntry)

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
      <div style={{ padding: '16px', overflowY: 'auto', maxHeight: 460 }}>
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

        {/* Default Tab Mode */}
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
            Default Tab Mode
          </label>
          <p
            style={{
              color: colors.textTertiary,
              fontSize: 12,
              margin: '0 0 10px',
              lineHeight: 1.4,
            }}
          >
            The permission mode new tabs start with.
          </p>
          <div
            style={{
              display: 'flex',
              background: colors.surfacePrimary,
              border: `1px solid ${colors.containerBorder}`,
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            {(['plan', 'auto', 'ask'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setDefaultPermissionMode(mode)}
                style={{
                  flex: 1,
                  padding: '7px 0',
                  background: defaultPermissionMode === mode ? colors.accent : 'transparent',
                  color: defaultPermissionMode === mode ? '#fff' : colors.textSecondary,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: defaultPermissionMode === mode ? 600 : 400,
                  textTransform: 'capitalize',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {/* Show Directory Label on Tabs */}
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
            Tab Directory Label
          </label>
          <p
            style={{
              color: colors.textTertiary,
              fontSize: 12,
              margin: '0 0 10px',
              lineHeight: 1.4,
            }}
          >
            Show the working directory name on each tab for quick identification.
          </p>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              cursor: 'pointer',
            }}
          >
            <div
              onClick={() => setShowDirLabel(!showDirLabel)}
              style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                background: showDirLabel ? colors.accent : colors.surfaceSecondary,
                position: 'relative',
                transition: 'background 0.15s',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  background: showDirLabel ? '#fff' : colors.textTertiary,
                  position: 'absolute',
                  top: 2,
                  left: showDirLabel ? 18 : 2,
                  transition: 'left 0.15s, background 0.15s',
                }}
              />
            </div>
            <span style={{ color: colors.textPrimary, fontSize: 13 }}>
              Show directory name on tabs
            </span>
          </label>
        </div>

        {/* Expand on Tab Switch */}
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
            Tab Switching
          </label>
          <p
            style={{
              color: colors.textTertiary,
              fontSize: 12,
              margin: '0 0 10px',
              lineHeight: 1.4,
            }}
          >
            Automatically expand the conversation when switching tabs.
          </p>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              cursor: 'pointer',
            }}
          >
            <div
              onClick={() => setExpandOnTabSwitch(!expandOnTabSwitch)}
              style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                background: expandOnTabSwitch ? colors.accent : colors.surfaceSecondary,
                position: 'relative',
                transition: 'background 0.15s',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  background: expandOnTabSwitch ? '#fff' : colors.textTertiary,
                  position: 'absolute',
                  top: 2,
                  left: expandOnTabSwitch ? 18 : 2,
                  transition: 'left 0.15s, background 0.15s',
                }}
              />
            </div>
            <span style={{ color: colors.textPrimary, fontSize: 13 }}>
              Expand on tab switch
            </span>
          </label>
        </div>

        {/* Show Implement Clear Context */}
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
            Plan Mode
          </label>
          <p
            style={{
              color: colors.textTertiary,
              fontSize: 12,
              margin: '0 0 10px',
              lineHeight: 1.4,
            }}
          >
            Show the "Implement, clear context" option when exiting plan mode.
          </p>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              cursor: 'pointer',
            }}
          >
            <div
              onClick={() => setShowImplementClearContext(!showImplementClearContext)}
              style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                background: showImplementClearContext ? colors.accent : colors.surfaceSecondary,
                position: 'relative',
                transition: 'background 0.15s',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  background: showImplementClearContext ? '#fff' : colors.textTertiary,
                  position: 'absolute',
                  top: 2,
                  left: showImplementClearContext ? 18 : 2,
                  transition: 'left 0.15s, background 0.15s',
                }}
              />
            </div>
            <span style={{ color: colors.textPrimary, fontSize: 13 }}>
              Show "Implement, clear context"
            </span>
          </label>
        </div>

        {/* Bash Command Entry */}
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
            Bash Command Entry
          </label>
          <p
            style={{
              color: colors.textTertiary,
              fontSize: 12,
              margin: '0 0 10px',
              lineHeight: 1.4,
            }}
          >
            Type ! as the first character to run bash commands directly in the conversation.
          </p>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              cursor: 'pointer',
            }}
          >
            <div
              onClick={() => setBashCommandEntry(!bashCommandEntry)}
              style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                background: bashCommandEntry ? colors.accent : colors.surfaceSecondary,
                position: 'relative',
                transition: 'background 0.15s',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  background: bashCommandEntry ? '#fff' : colors.textTertiary,
                  position: 'absolute',
                  top: 2,
                  left: bashCommandEntry ? 18 : 2,
                  transition: 'left 0.15s, background 0.15s',
                }}
              />
            </div>
            <span style={{ color: colors.textPrimary, fontSize: 13 }}>
              Enable bash command mode
            </span>
          </label>
        </div>
      </div>
    </div>
  )
}
