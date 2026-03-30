import React, { useState } from 'react'
import { UserCircle, Code } from '@phosphor-icons/react'
import { useColors, useThemeStore } from '../../theme'
import type { Icon } from '@phosphor-icons/react'

interface Preset {
  id: string
  name: string
  description: string
  icon: Icon
  values: Record<string, unknown>
  summary: string[]
}

const PRESETS: Preset[] = [
  {
    id: 'operator',
    name: 'Operator',
    description: 'Simple, low-friction experience. Outputs are collapsed and auto mode is the default.',
    icon: UserCircle,
    values: {
      defaultPermissionMode: 'auto',
      expandToolResults: false,
      expandedUI: false,
      allowSettingsEdits: false,
      bashCommandEntry: false,
      showTodoList: false,
      keepExplorerOnCollapse: false,
      keepTerminalOnCollapse: false,
      keepGitPanelOnCollapse: false,
    },
    summary: [
      'Permission mode: Auto',
      'Tool results: Collapsed',
      'Wide view: Off',
      'Settings edits: Off',
      'Bash entry: Off',
      'Task list: Off',
      'Panels on minimize: All closed',
    ],
  },
  {
    id: 'developer',
    name: 'Developer',
    description: 'Verbose output with planning mode, wide view, and agent settings access.',
    icon: Code,
    values: {
      defaultPermissionMode: 'plan',
      expandToolResults: true,
      expandedUI: true,
      allowSettingsEdits: true,
      bashCommandEntry: true,
      showTodoList: true,
      keepExplorerOnCollapse: false,
      keepTerminalOnCollapse: true,
      keepGitPanelOnCollapse: false,
    },
    summary: [
      'Permission mode: Plan',
      'Tool results: Expanded',
      'Wide view: On',
      'Settings edits: On',
      'Bash entry: On',
      'Task list: On',
      'Keep console on minimize',
    ],
  },
]

export function PresetsCategory() {
  const colors = useColors()
  const applyPreset = useThemeStore((s) => s.applyPreset)
  const [confirming, setConfirming] = useState<string | null>(null)

  const handleApply = (preset: Preset) => {
    applyPreset(preset.values)
    setConfirming(null)
  }

  return (
    <>
      <p style={{ color: colors.textTertiary, fontSize: 12, margin: '0 0 14px', lineHeight: 1.5 }}>
        Apply a preset to quickly configure multiple settings at once. You can customize individual settings afterwards.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {PRESETS.map((preset) => {
          const IconComp = preset.icon
          const isConfirming = confirming === preset.id

          return (
            <div
              key={preset.id}
              style={{
                background: colors.surfacePrimary,
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 12,
                padding: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <IconComp size={18} weight="bold" style={{ color: colors.accent }} />
                <span style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600 }}>
                  {preset.name}
                </span>
              </div>

              <p style={{ color: colors.textSecondary, fontSize: 12, margin: '0 0 10px', lineHeight: 1.4 }}>
                {preset.description}
              </p>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                {preset.summary.map((item) => (
                  <span
                    key={item}
                    style={{
                      background: colors.surfaceSecondary,
                      color: colors.textTertiary,
                      fontSize: 11,
                      padding: '3px 8px',
                      borderRadius: 6,
                    }}
                  >
                    {item}
                  </span>
                ))}
              </div>

              {isConfirming ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: colors.textSecondary, fontSize: 12, marginRight: 4 }}>
                    Overwrite current settings?
                  </span>
                  <button
                    onClick={() => handleApply(preset)}
                    style={{
                      background: colors.accent,
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      padding: '5px 14px',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    style={{
                      background: 'transparent',
                      color: colors.textTertiary,
                      border: `1px solid ${colors.containerBorder}`,
                      borderRadius: 6,
                      padding: '5px 14px',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirming(preset.id)}
                  style={{
                    background: colors.surfaceSecondary,
                    color: colors.textPrimary,
                    border: `1px solid ${colors.containerBorder}`,
                    borderRadius: 8,
                    padding: '6px 16px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                >
                  Apply
                </button>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
