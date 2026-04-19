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
    <div style={{ marginBottom: 14 }}>
      {label && (
        <label
          style={{
            display: 'block',
            color: colors.textSecondary,
            fontSize: 13,
            fontWeight: 500,
            marginBottom: 4,
          }}
        >
          {label}
        </label>
      )}
      {description && (
        <p
          style={{
            color: colors.textTertiary,
            fontSize: 11,
            margin: '0 0 6px',
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
