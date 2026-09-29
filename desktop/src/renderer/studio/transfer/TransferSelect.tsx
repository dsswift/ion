/**
 * TransferSelect — a themed choice field for the transfer dialog.
 *
 * The dialog's two choices, where the conversation goes and which directory
 * it lands in, were native `<select>`s: the only unthemed controls in the
 * app, and a list of bare paths with nothing saying which project each one
 * was. This is a trigger that looks like the rest of the dialog and opens
 * the same anchored menu the new-conversation picker uses (`PickerMenu`),
 * so each option can carry a name and, under it, the detail that tells two
 * similar options apart.
 *
 * `invalid` marks a choice the transfer cannot proceed without. The field
 * says so itself, in the danger colour, rather than leaving the operator to
 * work out why the button is disabled.
 */
import React, { useRef, useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { PickerMenu, PickerMenuOption } from '../../components/NewConversationPickerMenu'

export interface TransferSelectOption {
  value: string
  label: string
  /** The second line: what distinguishes this option from a similar one. */
  detail?: string
  icon?: React.ReactNode
  /**
   * A heading this option sits under. Consecutive options with the same
   * section share one heading; options with none sit directly under the
   * menu's own heading.
   */
  section?: string
}

export function TransferSelect({ label, heading, value, options, placeholder, invalid = false, invalidMessage, onChange, onOpenChange }: {
  /** The field's caption above the control, and its accessible name. */
  label: string
  /** The menu's heading. */
  heading: string
  value: string
  options: readonly TransferSelectOption[]
  placeholder: string
  invalid?: boolean
  invalidMessage?: string
  onChange(value: string): void
  /** Lets the dialog stand its own Escape handler down while the menu owns Escape. */
  onOpenChange?(open: boolean): void
}): React.JSX.Element {
  const colors = useColors()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const { hover, pressed, handlers } = useInteractiveState()
  const selected = options.find((o) => o.value === value) ?? null

  const setOpen = (next: { x: number; y: number } | null): void => {
    setAnchor(next)
    onOpenChange?.(next !== null)
  }
  const toggle = (): void => {
    if (anchor) { setOpen(null); return }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setOpen({ x: rect.left, y: rect.bottom + 4 })
  }
  const width = triggerRef.current?.getBoundingClientRect().width ?? 320

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 6 }}>{label}</div>
      <button
        ref={triggerRef}
        type="button"
        className="ion-focusable"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-invalid={invalid}
        {...handlers}
        onClick={toggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 40,
          padding: '6px 10px', boxSizing: 'border-box', textAlign: 'left', cursor: 'pointer',
          color: colors.textPrimary,
          background: interactiveBg(colors, { hover, pressed }, 'transparent'),
          border: `1px solid ${invalid ? colors.dangerFg : colors.containerBorder}`,
          borderRadius: 6,
          transition: `background ${transitions.fast}, border-color ${transitions.fast}`,
        }}
      >
        {selected?.icon && <span style={{ display: 'inline-flex', color: colors.textTertiary }}>{selected.icon}</span>}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? colors.textPrimary : colors.textTertiary }}>
            {selected ? selected.label : placeholder}
          </span>
          {selected?.detail && (
            <span style={{ display: 'block', marginTop: 1, fontSize: 10, color: colors.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.detail}</span>
          )}
        </span>
        <CaretDown size={12} color={colors.textTertiary} />
      </button>
      {invalid && invalidMessage && (
        <div role="alert" style={{ marginTop: 5, fontSize: 11, color: colors.dangerFg }}>{invalidMessage}</div>
      )}
      {anchor && (
        <PickerMenu anchor={anchor} ariaLabel={label} heading={heading} triggerEl={triggerRef.current} width={width} deps={[options.length]} onClose={() => setOpen(null)}>
          {options.map((option, index) => (
            <React.Fragment key={option.value}>
              {option.section && option.section !== options[index - 1]?.section && (
                <div role="presentation" style={{ padding: '8px 10px 5px', fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', opacity: 0.65, borderTop: index > 0 ? `1px solid ${colors.containerBorder}` : undefined, marginTop: index > 0 ? 4 : 0 }}>{option.section}</div>
              )}
              <PickerMenuOption
                selected={option.value === value}
                label={option.label}
                detail={option.detail}
                icon={option.icon}
                onClick={() => { onChange(option.value); setOpen(null) }}
              />
            </React.Fragment>
          ))}
        </PickerMenu>
      )}
    </div>
  )
}
