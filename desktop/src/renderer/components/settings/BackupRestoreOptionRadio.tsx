import React from 'react'
import { useColors } from '../../theme'

// Reusable radio-button-as-card used by both the export modal (for scope
// selection: currently-open vs. all) and the restore modal (for conflict
// policy: skip vs. overwrite vs. rename).
//
// Renamed from `ScopeRadio` because the restore modal uses it for policies,
// not scopes. The component is identical to what was previously inline in
// BackupRestoreCategory.tsx — only the file location and the name changed.

interface OptionRadioProps {
  label: string
  description: string
  checked: boolean
  onChange: () => void
  disabled: boolean
  colors: ReturnType<typeof useColors>
}

export function BackupRestoreOptionRadio({ label, description, checked, onChange, disabled, colors }: OptionRadioProps) {
  return (
    <label
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        padding: '8px 10px', borderRadius: 6,
        background: checked ? `${colors.accent}11` : colors.surfacePrimary,
        border: `1px solid ${checked ? colors.accent : colors.containerBorder}`,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        style={{ accentColor: colors.accent, marginTop: 2 }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: colors.textPrimary }}>{label}</div>
        <div style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>{description}</div>
      </div>
    </label>
  )
}
