import React from 'react'
import { useColors } from '../../theme'

interface SettingSectionProps {
  label?: string
  description?: string
  children: React.ReactNode
}

export function SettingSection({ label, description, children }: SettingSectionProps) {
  const colors = useColors()

  return (
    <div style={{ marginBottom: 20 }}>
      {label && (
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
      )}
      {description && (
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
      )}
      {children}
    </div>
  )
}
