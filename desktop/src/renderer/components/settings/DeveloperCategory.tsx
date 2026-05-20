import React from 'react'
import { useColors } from '../../theme'
import { useUpdateStore } from '../../stores/update-store'
import { SettingHeading } from './SettingHeading'
import { SettingSection } from './SettingSection'

export function DeveloperCategory() {
  const colors = useColors()
  const version = useUpdateStore((s) => s.version)
  const dialogOpen = useUpdateStore((s) => s.dialogOpen)

  return (
    <>
      <SettingHeading>Auto-Update</SettingHeading>

      <SettingSection
        label="Simulate Update Downloaded"
        description="Triggers the same code path as a real electron-updater notification. The update icon will appear in the input bar and the install dialog will open."
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => useUpdateStore.getState().setAvailable('9.9.9-dev')}
            style={{
              background: colors.surfacePrimary,
              border: `1px solid ${colors.containerBorder}`,
              borderRadius: 8,
              padding: '8px 14px',
              cursor: 'pointer',
              color: colors.textSecondary,
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            Simulate Update
          </button>
          {version && (
            <button
              onClick={() => useUpdateStore.setState({ version: null, dialogOpen: false })}
              style={{
                background: colors.surfacePrimary,
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 8,
                padding: '8px 14px',
                cursor: 'pointer',
                color: colors.textTertiary,
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              Clear
            </button>
          )}
        </div>
      </SettingSection>

      <SettingSection label="Update Store State">
        <div
          style={{
            background: colors.surfacePrimary,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 12,
            fontFamily: 'monospace',
            color: colors.textTertiary,
            lineHeight: 1.6,
          }}
        >
          <div>version: <span style={{ color: version ? colors.accent : colors.textTertiary }}>{version ?? 'null'}</span></div>
          <div>dialogOpen: <span style={{ color: dialogOpen ? colors.accent : colors.textTertiary }}>{String(dialogOpen)}</span></div>
        </div>
      </SettingSection>
    </>
  )
}
