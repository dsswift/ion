/**
 * Settings kit controls — the only buttons, inputs, selects, switches, and
 * segmented controls a Settings page uses. One height, one radius, one font,
 * so every row lines up whatever it holds.
 */
import React, { forwardRef } from 'react'
import type { Icon } from '@phosphor-icons/react'
import { useColors } from '../../../theme'
import { useInteractiveState } from '../../../hooks/useInteractiveState'
import { transitions } from '../../../theme-tokens'
import { Tooltip } from '../../git/Tooltip'
import { KIT } from './tokens'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'title'> {
  variant?: ButtonVariant
  /** Shown on hover: what the button does, or why it is disabled. */
  tooltip?: string
  icon?: Icon
  /** Stretches the button to its container's width. */
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', icon: IconComp, block, tooltip, children, disabled, ...rest }, ref,
) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const active = !disabled
  const palette: Record<ButtonVariant, { fg: string; bg: string; hoverBg: string; border: string }> = {
    primary: { fg: colors.textOnAccent, bg: colors.accent, hoverBg: colors.accentHover, border: 'transparent' },
    secondary: { fg: colors.textPrimary, bg: colors.surfacePrimary, hoverBg: colors.surfaceHover, border: colors.containerBorder },
    danger: { fg: colors.dangerFg, bg: colors.surfacePrimary, hoverBg: colors.surfaceHover, border: colors.containerBorder },
    ghost: { fg: colors.textSecondary, bg: 'transparent', hoverBg: colors.surfaceHover, border: 'transparent' },
  }
  const p = palette[variant]
  const button = (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      {...rest}
      {...handlers}
      className="ion-focusable"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        height: KIT.controlHeight, padding: children ? '0 10px' : 0, width: children ? (block ? '100%' : undefined) : KIT.controlHeight,
        fontSize: KIT.fontSmall, fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0,
        color: p.fg,
        background: active && variant === 'primary' && pressed ? colors.accentPressed : active && (hover || pressed) ? (variant === 'primary' ? p.hoverBg : pressed ? colors.surfacePressed : p.hoverBg) : p.bg,
        border: `1px solid ${p.border}`, borderRadius: KIT.radius,
        cursor: active ? 'pointer' : 'default', opacity: active ? 1 : 0.45,
        transition: `background ${transitions.base}`,
      }}
    >
      {IconComp && <IconComp size={13} weight={variant === 'primary' ? 'bold' : 'regular'} />}
      {children}
    </button>
  )
  return tooltip ? <Tooltip text={tooltip}>{button}</Tooltip> : button
})

/** A square icon-only button. `label` is its accessible name and tooltip. */
export function IconButton({ icon, label, variant = 'ghost', ...rest }: Omit<ButtonProps, 'icon' | 'children'> & { icon: Icon; label: string }): React.JSX.Element {
  return <Button {...rest} variant={variant} icon={icon} aria-label={label} tooltip={rest.tooltip ?? label} />
}

function useFieldStyle(): React.CSSProperties {
  const colors = useColors()
  return {
    height: KIT.controlHeight, boxSizing: 'border-box', padding: '0 8px', minWidth: 0,
    fontSize: KIT.fontSmall, color: colors.textPrimary, background: colors.inputBg,
    border: `1px solid ${colors.inputBorder}`, borderRadius: KIT.radius, outline: 'none',
  }
}

export interface TextInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'style' | 'size'> {
  mono?: boolean
  /** Fixed width; omitted fills the container. */
  width?: number
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput({ mono, width, ...rest }, ref) {
  const base = useFieldStyle()
  const colors = useColors()
  return (
    <input
      ref={ref}
      {...rest}
      onFocus={(e) => { e.currentTarget.style.borderColor = colors.inputFocusBorder; rest.onFocus?.(e) }}
      onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; rest.onBlur?.(e) }}
      style={{ ...base, width: width ?? '100%', fontFamily: mono ? KIT.mono : undefined }}
    />
  )
})

export function TextArea({ mono, rows = 4, ...rest }: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> & { mono?: boolean }): React.JSX.Element {
  const base = useFieldStyle()
  return <textarea rows={rows} {...rest} style={{ ...base, height: 'auto', width: '100%', padding: 8, resize: 'vertical', lineHeight: 1.45, fontFamily: mono ? KIT.mono : undefined }} />
}

export function Select({ width, children, ...rest }: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'style'> & { width?: number }): React.JSX.Element {
  const base = useFieldStyle()
  return <select {...rest} style={{ ...base, width: width ?? '100%', padding: '0 6px', cursor: rest.disabled ? 'default' : 'pointer' }}>{children}</select>
}

export interface SwitchProps {
  checked: boolean
  onChange(next: boolean): void
  label: string
  disabled?: boolean
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps): React.JSX.Element {
  const colors = useColors()
  return (
    <div
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className="ion-focusable"
      onKeyDown={(e) => { if (!disabled && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); onChange(!checked) } }}
      onClick={() => { if (!disabled) onChange(!checked) }}
      style={{
        width: 30, height: 18, borderRadius: 9, position: 'relative', flexShrink: 0,
        background: checked ? colors.accent : colors.surfaceSecondary,
        border: `1px solid ${checked ? 'transparent' : colors.containerBorder}`, boxSizing: 'border-box',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        transition: `background ${transitions.base}`,
      }}
    >
      <div style={{ width: 12, height: 12, borderRadius: 6, position: 'absolute', top: 2, left: checked ? 14 : 2, background: checked ? colors.textOnAccent : colors.textTertiary, transition: `left ${transitions.base}` }} />
    </div>
  )
}

export interface SegmentedOption<T extends string> { value: T; label: string }

export function Segmented<T extends string>({ value, options, onChange, label, disabled }: {
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange(next: T): void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  const colors = useColors()
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'inline-flex', height: KIT.controlHeight, boxSizing: 'border-box', padding: 2, gap: 2, borderRadius: KIT.radius, background: colors.surfaceSecondary, opacity: disabled ? 0.5 : 1 }}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className="ion-focusable"
            style={{
              padding: '0 10px', border: 'none', borderRadius: KIT.radius - 2, fontSize: KIT.fontSmall, fontWeight: on ? 600 : 500, whiteSpace: 'nowrap',
              color: on ? colors.textPrimary : colors.textSecondary, background: on ? colors.surfacePrimary : 'transparent',
              boxShadow: on ? `0 0 0 1px ${colors.containerBorder}` : 'none', cursor: disabled ? 'default' : 'pointer',
              transition: `background ${transitions.base}`,
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** A number field with a fixed width, for counts and sizes. */
export function NumberInput({ value, onChange, min, max, step = 1, label, width = 64 }: {
  value: number
  onChange(next: number): void
  min?: number
  max?: number
  step?: number
  label: string
  width?: number
}): React.JSX.Element {
  const base = useFieldStyle()
  return (
    <input
      type="number"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const next = Number(e.target.value)
        if (Number.isFinite(next)) onChange(next)
      }}
      style={{ ...base, width }}
    />
  )
}
