/**
 * Settings kit layout — a page header, grouped boxes of rows, and the rows
 * themselves. A form page is PageHeader + FormGroups of FormRows; nothing
 * else sets spacing.
 *
 * `anchor` puts a `data-settings-anchor` on a row or group so a search hit
 * can scroll to it and flash it (see `revealSettingsAnchor`).
 */
import React, { useId } from 'react'
import { useColors } from '../../../theme'
import { Switch } from './controls'
import { KIT } from './tokens'
import { useSealedToggleValue, useSettingLock } from '../../../settings-policy'

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  return (
    <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: colors.textPrimary, letterSpacing: -0.1 }}>{title}</h2>
        {description && <p style={{ margin: '3px 0 0', fontSize: KIT.fontSmall, color: colors.textTertiary, lineHeight: 1.45 }}>{description}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>{actions}</div>}
    </header>
  )
}

/** Stacks a page's groups with the one group gap. */
export function Page({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ maxWidth: KIT.pageMaxWidth, display: 'flex', flexDirection: 'column', gap: KIT.groupGap }}>{children}</div>
}

/** The title line above a group or list: title, description, and actions on the right. */
export function GroupHeader({ title, description, actions }: { title?: string; description?: React.ReactNode; actions?: React.ReactNode }): React.JSX.Element | null {
  const colors = useColors()
  if (!title && !description && !actions) return null
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginBottom: 6, padding: '0 2px' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontSize: KIT.fontSmall, fontWeight: 600, color: colors.textSecondary }}>{title}</div>}
        {description && <div style={{ fontSize: KIT.fontTiny, color: colors.textTertiary, marginTop: 1, lineHeight: 1.4 }}>{description}</div>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>{actions}</div>}
    </div>
  )
}

/** The rounded box rows sit in. Draws the hairline between rows itself. */
export function Group({ children, padded }: { children: React.ReactNode; padded?: boolean }): React.JSX.Element {
  const colors = useColors()
  const rows = React.Children.toArray(children)
  return (
    <div style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.groupRadius, background: colors.surfacePrimary, overflow: 'hidden', padding: padded ? KIT.inset : 0 }}>
      {padded ? children : rows.map((row, i) => (
        <div key={i} style={{ borderTop: i === 0 ? 'none' : `1px solid ${colors.borderSubtle}` }}>{row}</div>
      ))}
    </div>
  )
}

export function FormGroup({ title, description, actions, anchor, children }: {
  title?: string
  description?: React.ReactNode
  actions?: React.ReactNode
  anchor?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} data-settings-anchor={anchor}>
      <GroupHeader title={title} description={description} actions={actions} />
      <Group>{children}</Group>
    </section>
  )
}

export interface FormRowProps {
  label: string
  description?: React.ReactNode
  /** Puts the control under the label, full width. For editors and wide inputs. */
  stacked?: boolean
  anchor?: string
  /** An enforced value: why the control does not respond. */
  lockedReason?: string
  /**
   * The setting this row edits. When the enterprise settings policy seals it
   * for the server Settings is editing, the row says so and its controls stop
   * responding.
   */
  settingKey?: string
  warning?: string
  children?: React.ReactNode
}

export function FormRow({ label, description, stacked, anchor, lockedReason: lockedByCaller, settingKey, warning, children }: FormRowProps): React.JSX.Element {
  const colors = useColors()
  const sealedReason = useSettingLock(settingKey)
  const lockedReason = lockedByCaller ?? sealedReason
  const text = (
    <div style={{ flex: stacked ? undefined : '1 1 auto', minWidth: 0 }}>
      <div style={{ fontSize: KIT.font, fontWeight: 500, color: colors.textPrimary }}>{label}</div>
      {description && <div style={{ fontSize: KIT.fontTiny + 0.5, color: colors.textTertiary, marginTop: 2, lineHeight: 1.4 }}>{description}</div>}
      {lockedReason && <div style={{ fontSize: KIT.fontTiny, color: colors.textTertiary, marginTop: 2, fontStyle: 'italic' }}>{lockedReason}</div>}
      {warning && <div style={{ fontSize: KIT.fontTiny, color: colors.statusWarning, marginTop: 2 }}>{warning}</div>}
    </div>
  )
  return (
    <div
      data-settings-anchor={anchor}
      style={{
        display: 'flex', flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center',
        gap: stacked ? 8 : 16, minHeight: KIT.formRowHeight, boxSizing: 'border-box', padding: `8px ${KIT.inset}px`,
      }}
    >
      {text}
      {children !== undefined && (
        <div inert={sealedReason !== undefined} style={{ display: 'flex', alignItems: 'center', justifyContent: stacked ? 'flex-start' : 'flex-end', gap: 6, flexShrink: stacked ? undefined : 0, maxWidth: stacked ? undefined : '55%', minWidth: 0, opacity: sealedReason !== undefined ? 0.55 : undefined }}>
          {children}
        </div>
      )}
    </div>
  )
}

export function ToggleRow({ label, description, checked, onChange, lockedReason, settingKey, warning, anchor }: Omit<FormRowProps, 'children' | 'stacked'> & {
  checked: boolean
  onChange(next: boolean): void
}): React.JSX.Element {
  const sealedValue = useSealedToggleValue(settingKey)
  const sealed = useSettingLock(settingKey) !== undefined
  return (
    <FormRow label={label} description={description} lockedReason={lockedReason} settingKey={settingKey} warning={warning} anchor={anchor}>
      <Switch checked={sealedValue ?? checked} onChange={onChange} label={label} disabled={!!lockedReason || sealed} />
    </FormRow>
  )
}

/**
 * A labelled field inside a side panel or an inline form: label over control,
 * hint under. A group, not a `<label>`: a label forwards a click anywhere in
 * it to its first control, which fires the first button of a picker grid.
 * Controls carry their own accessible names.
 */
export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  const labelId = useId()
  return (
    <div role="group" aria-labelledby={labelId} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span id={labelId} style={{ fontSize: KIT.fontTiny, fontWeight: 600, color: colors.textSecondary }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: KIT.fontTiny, color: colors.textTertiary, lineHeight: 1.4 }}>{hint}</span>}
    </div>
  )
}

/** Vertical rhythm for the body of a side panel or an inline form. */
export function Stack({ gap = 12, children }: { gap?: number; children: React.ReactNode }): React.JSX.Element {
  return <div style={{ display: 'flex', flexDirection: 'column', gap }}>{children}</div>
}

export function Inline({ gap = 6, wrap, children }: { gap?: number; wrap?: boolean; children: React.ReactNode }): React.JSX.Element {
  return <div style={{ display: 'flex', alignItems: 'center', gap, flexWrap: wrap ? 'wrap' : undefined, minWidth: 0 }}>{children}</div>
}

/**
 * Scrolls a search hit's row into view and flashes it once. The flash is a
 * single short animation, never a repeating one.
 */
export function revealSettingsAnchor(root: HTMLElement | null, anchor: string): boolean {
  const el = root?.querySelector<HTMLElement>(`[data-settings-anchor="${CSS.escape(anchor)}"]`)
  if (!el) return false
  el.scrollIntoView({ block: 'center' })
  el.animate?.([{ boxShadow: 'inset 0 0 0 2px var(--ion-accent)' }, { boxShadow: 'inset 0 0 0 2px transparent' }], { duration: 1400, easing: 'ease-out' })
  return true
}
