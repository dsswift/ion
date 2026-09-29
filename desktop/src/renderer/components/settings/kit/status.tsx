/**
 * Settings kit status parts — the dot, chip, notice, and empty state every
 * page uses to say how something is, instead of each page styling its own.
 */
import React from 'react'
import type { Icon } from '@phosphor-icons/react'
import { useColors } from '../../../theme'
import type { ColorPalette } from '../../../theme-tokens'
import { Tooltip } from '../../git/Tooltip'
import { KIT } from './tokens'

export type Tone = 'ok' | 'warn' | 'error' | 'muted' | 'accent'

export function toneColor(colors: ColorPalette, tone: Tone): string {
  switch (tone) {
    case 'ok': return colors.successFg
    case 'warn': return colors.statusWarning
    case 'error': return colors.statusError
    case 'accent': return colors.accent
    case 'muted': return colors.textTertiary
  }
}

export function StatusDot({ tone, label }: { tone: Tone; label?: string }): React.JSX.Element {
  const colors = useColors()
  const dot = <span role={label ? 'img' : undefined} aria-label={label} style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: toneColor(colors, tone) }} />
  return label ? <Tooltip text={label} style={{ display: 'inline-flex' }}>{dot}</Tooltip> : dot
}

export function Chip({ tone = 'muted', children }: { tone?: Tone; children: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  const color = toneColor(colors, tone)
  return <span style={{ display: 'inline-flex', alignItems: 'center', height: 17, fontSize: 10, fontWeight: 500, color, border: `1px solid ${color}`, borderRadius: 999, padding: '0 6px', whiteSpace: 'nowrap', boxSizing: 'border-box', flexShrink: 0 }}>{children}</span>
}

export function Muted({ children, mono }: { children: React.ReactNode; mono?: boolean }): React.JSX.Element {
  const colors = useColors()
  return <span style={{ fontSize: KIT.fontSmall, color: colors.textTertiary, fontFamily: mono ? KIT.mono : undefined }}>{children}</span>
}

/** One truncated line of monospace text; the full value is its tooltip. */
export function MonoLine({ children, title }: { children: string; title?: string }): React.JSX.Element {
  const colors = useColors()
  return (
    <Tooltip text={title ?? children} style={{ display: 'block', minWidth: 0, overflow: 'hidden' }}>
      <span style={{ display: 'block', minWidth: 0, fontFamily: KIT.mono, fontSize: KIT.fontTiny, color: colors.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>
    </Tooltip>
  )
}

export function ErrorText({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const colors = useColors()
  if (!children) return null
  return <div role="alert" style={{ fontSize: KIT.fontSmall, color: colors.dangerFg, margin: '6px 0' }}>{children}</div>
}

export function Notice({ tone = 'muted', children, action }: { tone?: Tone; children: React.ReactNode; action?: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  const accent = tone === 'muted' ? colors.containerBorder : toneColor(colors, tone)
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: KIT.radius + 2, border: `1px solid ${accent}`, background: colors.surfacePrimary, fontSize: KIT.fontSmall, color: colors.textSecondary, lineHeight: 1.45 }}>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {action}
    </div>
  )
}

export function EmptyState({ icon: IconComp, title, detail, action }: { icon?: Icon; title: string; detail?: React.ReactNode; action?: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 6, padding: '22px 16px' }}>
      {IconComp && <IconComp size={20} color={colors.textTertiary} />}
      <div style={{ fontSize: KIT.font, fontWeight: 500, color: colors.textSecondary }}>{title}</div>
      {detail && <div style={{ fontSize: KIT.fontSmall, color: colors.textTertiary, maxWidth: 420, lineHeight: 1.45 }}>{detail}</div>}
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </div>
  )
}
