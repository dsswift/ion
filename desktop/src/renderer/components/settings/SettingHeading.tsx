import React from 'react'
import { useColors } from '../../theme'

interface SettingHeadingProps {
  children: React.ReactNode
  first?: boolean
}

export function SettingHeading({ children, first }: SettingHeadingProps) {
  const colors = useColors()

  return (
    <div
      style={{
        paddingTop: first ? 0 : 6,
        paddingBottom: 8,
        marginBottom: 2,
        borderTop: first ? 'none' : `1px solid ${colors.containerBorder}`,
      }}
    >
      <span
        style={{
          color: colors.textPrimary,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {children}
      </span>
    </div>
  )
}
