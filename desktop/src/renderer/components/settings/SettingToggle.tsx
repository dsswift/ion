import React from 'react'
import { useColors } from '../../theme'

interface SettingToggleProps {
  label: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
  warning?: string
  /**
   * Renders the control as enforced: the switch stops responding and dims,
   * and the reason is shown beneath the description. Used where enterprise
   * policy owns the value, so the setting stays visible and explains itself
   * rather than vanishing.
   */
  lockedReason?: string
}

export function SettingToggle({ label, description, checked, onChange, warning, lockedReason }: SettingToggleProps) {
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
          onClick={() => { if (!lockedReason) onChange(!checked) }}
          style={{
            width: 32,
            height: 18,
            borderRadius: 9,
            background: checked ? colors.accent : colors.surfaceSecondary,
            position: 'relative',
            transition: 'background 0.15s',
            cursor: lockedReason ? 'not-allowed' : 'pointer',
            opacity: lockedReason ? 0.5 : 1,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: 7,
              background: checked ? colors.textOnAccent : colors.textTertiary,
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
      {lockedReason && (
        <p
          style={{
            color: colors.textTertiary,
            fontSize: 11,
            margin: '2px 0 0',
            lineHeight: 1.4,
            fontStyle: 'italic',
          }}
        >
          {lockedReason}
        </p>
      )}
      {checked && warning && (
        <p
          style={{
            color: colors.warningFg,
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
