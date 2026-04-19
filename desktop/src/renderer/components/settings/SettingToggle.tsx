import React from 'react'
import { useColors } from '../../theme'

interface SettingToggleProps {
  label: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
  warning?: string
}

export function SettingToggle({ label, description, checked, onChange, warning }: SettingToggleProps) {
  const colors = useColors()

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          style={{
            color: colors.textSecondary,
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {label}
        </span>
        <div
          onClick={() => onChange(!checked)}
          style={{
            width: 32,
            height: 18,
            borderRadius: 9,
            background: checked ? colors.accent : colors.surfaceSecondary,
            position: 'relative',
            transition: 'background 0.15s',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: 7,
              background: checked ? '#fff' : colors.textTertiary,
              position: 'absolute',
              top: 2,
              left: checked ? 16 : 2,
              transition: 'left 0.15s, background 0.15s',
            }}
          />
        </div>
      </div>
      <p
        style={{
          color: colors.textTertiary,
          fontSize: 11,
          margin: '2px 0 0',
          lineHeight: 1.4,
        }}
      >
        {description}
      </p>
      {checked && warning && (
        <p
          style={{
            color: '#d97706',
            fontSize: 10,
            margin: '4px 0 0',
            lineHeight: 1.4,
            opacity: 0.85,
          }}
        >
          {warning}
        </p>
      )}
    </div>
  )
}
