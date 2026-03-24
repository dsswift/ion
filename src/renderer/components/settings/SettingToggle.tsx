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
        {label}
      </label>
      <p
        style={{
          color: colors.textTertiary,
          fontSize: 12,
          margin: '0 0 10px',
          lineHeight: 1.4,
        }}
      >
        {description}
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
          onClick={() => onChange(!checked)}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            background: checked ? colors.accent : colors.surfaceSecondary,
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
              background: checked ? '#fff' : colors.textTertiary,
              position: 'absolute',
              top: 2,
              left: checked ? 18 : 2,
              transition: 'left 0.15s, background 0.15s',
            }}
          />
        </div>
      </label>
      {checked && warning && (
        <p
          style={{
            color: '#d97706',
            fontSize: 11,
            margin: '8px 0 0',
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
