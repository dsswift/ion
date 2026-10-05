/**
 * Tabs — splits one page into views shown one at a time. A tab is a word,
 * an optional mark before it, and an optional count after it; the selected
 * one is underlined. Controls that apply to every view sit at the right end
 * of the tab row.
 */
import React from 'react'
import { useColors } from '../../../theme'
import { transitions } from '../../../theme-tokens'
import { KIT } from './tokens'

export interface TabOption<T extends string> {
  value: T
  label: string
  count?: number
  icon?: React.ReactNode
}

export function Tabs<T extends string>({ value, options, onChange, label, actions }: {
  value: T
  options: ReadonlyArray<TabOption<T>>
  onChange(next: T): void
  /** Accessible name of the tab list. */
  label: string
  /** Controls at the right end of the row, for what applies to every view. */
  actions?: React.ReactNode
}): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${colors.borderSubtle}` }}>
      <div role="tablist" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', columnGap: 20, flex: 1, minWidth: 0, marginBottom: -1 }}>
        {options.map((o) => {
          const on = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="tab"
              aria-selected={on}
              data-tab={o.value}
              onClick={() => onChange(o.value)}
              className="ion-focusable"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 2px', marginBottom: -1, border: 'none', background: 'transparent',
                borderBottom: `2px solid ${on ? colors.textPrimary : 'transparent'}`, fontSize: KIT.font, fontWeight: on ? 600 : 500, whiteSpace: 'nowrap',
                color: on ? colors.textPrimary : colors.textSecondary, cursor: 'pointer', transition: `color ${transitions.base}`,
              }}
            >
              {o.icon}
              {o.label}
              {o.count !== undefined && (
                <span style={{ fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: colors.textSecondary, background: colors.surfaceSecondary, borderRadius: 999, padding: '1px 6px' }}>{o.count}</span>
              )}
            </button>
          )
        })}
      </div>
      {actions && <div style={{ display: 'flex', gap: 6, paddingBottom: 4 }}>{actions}</div>}
    </div>
  )
}
