/**
 * StatusDrawer presentational parts.
 *
 * Extracted from StatusDrawer.tsx, which sits under an explicit file-size cap
 * and had ~12 lines of headroom. Everything here is pure presentation: each
 * part takes its data and a `colors` palette as props and reads no store, so
 * the split is at a real seam rather than an arbitrary line cut.
 *
 * StatusDrawer.tsx keeps the store wiring, the section composition, and the
 * derived figures; this file keeps the badges, bars, rows, and formatters.
 */

import React, { useState, useCallback } from 'react'
import { Copy, Check } from '@phosphor-icons/react'
import { useColors } from '../theme'
import type { ColorPalette } from '../theme-tokens'
import type { ContextBreakdownCategory, ModelBreakdown } from '../../shared/types-engine'
import { rError } from '../rendererLogger'

// ─── Tier badge ──────────────────────────────────────────────────────────────

export type Tier = 'exact' | 'local' | 'approximate'

const TIER_LABEL: Record<Tier, string> = { exact: 'exact', local: 'bpe', approximate: '~' }
const TIER_TITLE: Record<Tier, string> = {
  exact: 'Provider native count-tokens endpoint',
  local: 'Local BPE tokenizer (tiktoken)',
  approximate: 'Character/4 heuristic (fallback)',
}

export function TierBadge({ tier, colors }: { tier: Tier; colors: ReturnType<typeof useColors> }) {
  const bg = tier === 'exact' ? colors.accentLight : tier === 'local' ? colors.surfaceActive : colors.surfaceHover
  const fg = tier === 'exact' ? colors.accent : tier === 'local' ? colors.textTertiary : colors.textMuted
  return (
    <span title={TIER_TITLE[tier]} style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: bg, color: fg, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
      {TIER_LABEL[tier]}
    </span>
  )
}

// ─── Usage bar ───────────────────────────────────────────────────────────────

export function UsageBar({ percent, colors }: { percent: number; colors: ReturnType<typeof useColors> }) {
  const clamped = Math.max(0, Math.min(100, percent))
  const barColor = clamped >= 90 ? colors.statusError : clamped >= 70 ? colors.statusWarning : colors.accent
  return (
    <div style={{ height: 4, borderRadius: 2, background: colors.containerBorder, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ height: '100%', width: `${clamped}%`, background: barColor, borderRadius: 2, transition: 'width 0.4s ease' }} />
    </div>
  )
}

// ─── Section header ───────────────────────────────────────────────────────────

export function SectionHeader({ label, colors }: { label: string; colors: ReturnType<typeof useColors> }) {
  return (
    <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: colors.textTertiary, paddingBottom: 6, borderBottom: `1px solid ${colors.containerBorder}`, marginBottom: 8 }}>
      {label}
    </div>
  )
}

// ─── Elapsed display ─────────────────────────────────────────────────────────

export function elapsedStr(startTime: number | undefined): string {
  if (!startTime) return ''
  const s = Math.floor((Date.now() - startTime) / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
}

// ─── Kind ordering + colors for proportion graph ──────────────────────────────

// Fixed display order for kind buckets (C3). Maps engine kind values to display labels.
export const KIND_ORDER = ['system_prompt', 'tools', 'conversation', 'file', 'unaccounted'] as const
export type KindKey = (typeof KIND_ORDER)[number]

export const KIND_LABEL: Record<KindKey, string> = {
  system_prompt: 'System Prompt',
  tools: 'Tools',
  conversation: 'Conversation',
  file: 'Files',
  unaccounted: 'Unaccounted',
}

// Theme-token keys for the proportion graph segments (per kind bucket).
// Resolved through useColors() at render time so the graph follows the theme.
export const KIND_COLOR: Record<KindKey, keyof ColorPalette> = {
  system_prompt: 'iconPurple',
  tools: 'infoFg',
  conversation: 'successFg',
  file: 'statusWarning',
  unaccounted: 'textTertiary',
}

export function kindKey(kind: string): KindKey {
  if (kind === 'system_prompt' || kind === 'system-prompt') return 'system_prompt'
  if (kind === 'tools' || kind === 'tool') return 'tools'
  if (kind === 'conversation' || kind === 'message') return 'conversation'
  if (kind === 'file') return 'file'
  return 'unaccounted'
}

// ─── Proportion graph (C4) ────────────────────────────────────────────────────

export interface GraphSegment { kind: KindKey; tokens: number; pct: number }

export function ProportionGraph({ segments, contextWindow, colors }: {
  segments: GraphSegment[]
  contextWindow: number
  colors: ReturnType<typeof useColors>
}) {
  const usedPct = segments.reduce((s, g) => s + g.pct, 0)
  const freePct = Math.max(0, 100 - usedPct)
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: colors.surfaceHover }}>
        {segments.map((seg) => seg.pct > 0 && (
          <div key={seg.kind} title={`${KIND_LABEL[seg.kind]}: ${seg.tokens.toLocaleString()} tokens (${seg.pct.toFixed(1)}%)`}
            style={{ width: `${seg.pct}%`, background: colors[KIND_COLOR[seg.kind]], transition: 'width 0.4s ease' }} />
        ))}
        {freePct > 0 && (
          <div title={`Free: ${(freePct / 100 * contextWindow).toFixed(0)} tokens (${freePct.toFixed(1)}%)`}
            style={{ flex: 1, background: 'transparent' }} />
        )}
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', marginTop: 4 }}>
        {segments.filter((s) => s.pct > 0).map((seg) => (
          <span key={seg.kind} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: colors.textTertiary }}>
            <span style={{ width: 6, height: 6, borderRadius: 1, background: colors[KIND_COLOR[seg.kind]], flexShrink: 0, display: 'inline-block' }} />
            {KIND_LABEL[seg.kind]}
          </span>
        ))}
        {freePct > 0.5 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: colors.textMuted }}>
            <span style={{ width: 6, height: 6, borderRadius: 1, background: colors.surfaceActive, flexShrink: 0, display: 'inline-block' }} />
            Free
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Grouped breakdown rows (C3) ─────────────────────────────────────────────

export function groupCategories(categories: ContextBreakdownCategory[]): Map<KindKey, ContextBreakdownCategory[]> {
  const map = new Map<KindKey, ContextBreakdownCategory[]>()
  for (const cat of categories) {
    const k = kindKey(cat.kind)
    const existing = map.get(k) ?? []
    existing.push(cat)
    map.set(k, existing)
  }
  // Sort within each bucket: descending by tokens
  for (const [k, items] of map) {
    map.set(k, items.slice().sort((a, b) => b.tokens - a.tokens))
  }
  // Return in fixed kind order (only present buckets)
  const ordered = new Map<KindKey, ContextBreakdownCategory[]>()
  for (const k of KIND_ORDER) {
    if (map.has(k)) ordered.set(k, map.get(k)!)
  }
  return ordered
}

export function CategoryRow({ cat, contextWindow, colors, indent }: {
  cat: ContextBreakdownCategory
  contextWindow: number
  colors: ReturnType<typeof useColors>
  indent?: boolean
}) {
  const pct = contextWindow > 0 ? Math.round((cat.tokens / contextWindow) * 100) : 0
  const label = cat.path ? cat.path.split('/').slice(-2).join('/') : cat.name
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: indent ? 12 : 0 }}>
      {indent && <span style={{ fontSize: 9, color: colors.textMuted, flexShrink: 0 }}>↳</span>}
      <span style={{ fontSize: 10, color: colors.textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cat.path || cat.name}>
        {label}
      </span>
      <span style={{ fontSize: 10, color: colors.textPrimary, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {cat.tokens.toLocaleString()}
      </span>
      <span style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0, minWidth: 28, textAlign: 'right' }}>
        {pct}%
      </span>
      <TierBadge tier={cat.tier as Tier} colors={colors} />
    </div>
  )
}

// ─── Copy button ─────────────────────────────────────────────────────────────

export function CopyButton({ value, label, colors }: { value: string; label: string; colors: ReturnType<typeof useColors> }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch((err) => rError('status-drawer', 'copy failed', { label, error: String(err) }))
  }, [value, label])
  return (
    <button onClick={handleCopy} title={`Copy ${label}`}
      style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'transparent', border: 'none', cursor: 'pointer', color: copied ? colors.accent : colors.textTertiary, padding: '1px 4px', borderRadius: 3 }}>
      {copied ? <Check size={10} /> : <Copy size={10} />}
      <span style={{ fontSize: 9 }}>{copied ? 'copied' : label}</span>
    </button>
  )
}

// ─── Per-model cost breakdown rows ────────────────────────────────────────────

// Renders the per-model cost rows under the aggregate cost, split into two
// groups: the viewing conversation's OWN spend (isSelf rows) under a
// "This conversation" sub-label, and the dispatch spend (non-self rows) under
// a "Dispatches" sub-label. When there are no dispatch rows, only the self group
// renders (no "Dispatches" header). This makes explicit that e.g. an opus row
// marked $397 is the viewing conversation's lifetime cost, not one dispatch.
export function ModelBreakdownRows({ rows, colors }: { rows: ModelBreakdown[]; colors: ReturnType<typeof useColors> }) {
  const selfRows = rows.filter((r) => r.isSelf)
  const dispatchRows = rows.filter((r) => !r.isSelf)

  const groupLabel = (label: string) => (
    <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: colors.textMuted, paddingLeft: 10, marginTop: 2 }}>
      {label}
    </div>
  )

  const row = (mb: ModelBreakdown) => (
    <div key={`${mb.model}-${mb.isSelf ? 'self' : 'dispatch'}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 18 }}>
      <span style={{ fontSize: 9, color: colors.textMuted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${mb.model} — ${mb.conversations} conv`}>
        {mb.model} ({mb.conversations})
      </span>
      <span style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>${mb.costUsd.toFixed(4)}</span>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {selfRows.length > 0 && (
        <>
          {groupLabel('This conversation')}
          {selfRows.map(row)}
        </>
      )}
      {dispatchRows.length > 0 && (
        <>
          {groupLabel('Dispatches')}
          {dispatchRows.map(row)}
        </>
      )}
    </div>
  )
}
