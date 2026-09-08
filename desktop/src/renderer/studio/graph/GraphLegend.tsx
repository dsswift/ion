/**
 * GraphLegend — the key to the picture. Every bound channel gets a row an
 * operator can read the encoding from: a swatch per value for a
 * categorical colour, a ramp for a numeric one, a glyph per shape, a size
 * ladder, an edge-weight ladder. With nothing bound it shows the
 * structural defaults (document, topic, anchor, section, dangling, and the
 * edge kinds) so the stage's colours are never a guess.
 *
 * The scales are rebuilt here from the same inputs the canvas uses, so the
 * legend can never disagree with what is drawn.
 *
 * It starts collapsed to a chip: expanded, it covers a corner of the stage
 * that the operator usually wants for the graph. Open state is per view
 * instance and never persisted.
 */

import React, { useMemo, useState } from 'react'
import { useColors } from '../../theme'
import { useGraphStore } from './graph-store'
import { buildChannelScales } from './channels/build-channel-scales'
import { CATEGORICAL_SHAPE_CYCLE, type Scale } from './channels/scales'
import { categoricalColorPalette } from './channels/categorical-palette'
import type { ChannelBindings } from '../../../shared/graph-view-types'
import type { ColorPalette } from '../../theme-tokens'

type ChannelName = keyof ChannelBindings

const CHANNEL_LABELS: Record<ChannelName, string> = {
  nodeColor: 'Color',
  nodeShape: 'Shape',
  nodeSize: 'Size',
  edgeColor: 'Edge color',
  edgeThickness: 'Edge weight',
  edgeOpacity: 'Edge opacity',
}

/** How many categorical values get their own row before the rest fold into "+N more". */
export const MAX_LEGEND_VALUES = 8

function dimensionLabel(binding: ChannelBindings[ChannelName]): string {
  if (!binding.dimension) return 'unbound'
  const d = binding.dimension
  if (d.source === 'frontMatter') return d.field
  if (d.source === 'structural') return d.metric
  if (d.source === 'mechanical') return d.property
  return d.metric
}

function Swatch({ color, shape = 'circle', size = 9 }: { color: string; shape?: string; size?: number }): React.JSX.Element {
  const colors = useColors()
  const base: React.CSSProperties = { width: size, height: size, flexShrink: 0, display: 'inline-block', background: color, boxSizing: 'border-box' }
  if (shape === 'square') return <span style={{ ...base, borderRadius: 2 }} />
  if (shape === 'border') return <span style={{ ...base, borderRadius: '50%', border: `2px solid ${colors.graphLabelHub}` }} />
  if (shape === 'point') return <span style={{ ...base, width: Math.max(3, size - 4), height: Math.max(3, size - 4), borderRadius: '50%' }} />
  return <span style={{ ...base, borderRadius: '50%' }} />
}

function EdgeSample({ color, thickness, alpha = 1 }: { color: string; thickness: number; alpha?: number }): React.JSX.Element {
  return <span style={{ display: 'inline-block', width: 22, height: Math.max(1, thickness), background: color, opacity: alpha, flexShrink: 0, borderRadius: 1 }} />
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 16 }}>
      {children}
      <span style={{ color: colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  )
}

function Heading({ channel, binding }: { channel: ChannelName; binding: ChannelBindings[ChannelName] }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'baseline', marginTop: 6 }}>
      <span style={{ fontWeight: 600, color: colors.textPrimary }}>{CHANNEL_LABELS[channel]}</span>
      <span style={{ color: colors.textTertiary }}>{dimensionLabel(binding)}</span>
    </div>
  )
}

/** Rows for one categorical scale: a sample per value, folded past `MAX_LEGEND_VALUES`. */
function CategoricalRows({ channel, scale }: { channel: ChannelName; scale: Scale }): React.JSX.Element | null {
  const colors = useColors()
  const appearanceCount = categoricalColorPalette(colors).length
  if (!Array.isArray(scale.domain)) return null
  const domain = scale.domain as string[]
  const shown = domain.slice(0, MAX_LEGEND_VALUES)
  const rest = domain.length - shown.length
  return (
    <>
      {shown.map((value, i) => {
        const appearance = scale.apply(value)
        const count = scale.counts?.[i]
        const label = count !== undefined ? `${value} · ${count}` : value
        if (channel === 'nodeShape') return <Row key={value} label={label}><Swatch color={colors.graphNodeDefault} shape={String(appearance)} /></Row>
        if (channel === 'edgeThickness') return <Row key={value} label={label}><EdgeSample color={colors.textSecondary} thickness={Number(appearance)} /></Row>
        if (channel === 'edgeOpacity') return <Row key={value} label={label}><EdgeSample color={colors.textSecondary} thickness={2} alpha={Number(appearance)} /></Row>
        if (channel === 'nodeSize') return <Row key={value} label={label}><Swatch color={colors.graphNodeDefault} size={Math.max(4, Number(appearance))} /></Row>
        return <Row key={value} label={label}><Swatch color={String(appearance)} /></Row>
      })}
      {rest > 0 && <div style={{ color: colors.textTertiary }}>+{rest} more</div>}
      {channel === 'nodeShape' && domain.length > CATEGORICAL_SHAPE_CYCLE.length && (
        <div style={{ color: colors.textTertiary }}>values past {CATEGORICAL_SHAPE_CYCLE.length} draw as unknown</div>
      )}
      {(channel === 'nodeColor' || channel === 'edgeColor') && domain.length > appearanceCount && (
        // The fold is stated, never silent: past the colour cycle a value
        // draws as the unknown grey, and the key says how many do.
        <Row label={`${domain.length - appearanceCount} values past ${appearanceCount} draw as unknown`}><Swatch color={colors.graphUnknown} /></Row>
      )}
    </>
  )
}

/** A ramp for a numeric or temporal scale: min, midpoint, max samples. */
function RampRows({ channel, scale }: { channel: ChannelName; scale: Scale }): React.JSX.Element | null {
  const colors = useColors()
  if (!Array.isArray(scale.domain) || scale.domain.length !== 2 || typeof scale.domain[0] !== 'number') return null
  const [min, max] = scale.domain as [number, number]
  const stops = min === max ? [min] : [min, (min + max) / 2, max]
  if (channel === 'nodeColor' || channel === 'edgeColor') {
    const gradient = `linear-gradient(to right, ${stops.map((v) => String(scale.apply(v))).join(', ')})`
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: colors.textTertiary }}>{formatNumber(min)}</span>
        <span style={{ display: 'inline-block', flex: 1, height: 8, borderRadius: 4, background: gradient, minWidth: 60 }} />
        <span style={{ color: colors.textTertiary }}>{formatNumber(max)}</span>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {stops.map((v) => {
        const appearance = Number(scale.apply(v))
        return (
          <span key={v} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {channel === 'nodeSize' && <Swatch color={colors.graphNodeDefault} size={Math.max(4, appearance)} />}
            {channel === 'edgeThickness' && <EdgeSample color={colors.textSecondary} thickness={appearance} />}
            {channel === 'edgeOpacity' && <EdgeSample color={colors.textSecondary} thickness={2} alpha={appearance} />}
            <span style={{ color: colors.textTertiary }}>{formatNumber(v)}</span>
          </span>
        )
      })}
    </div>
  )
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(2)
}

/**
 * The structural defaults: the node classes (document, topic, anchor,
 * section, dangling) and the edge kinds (a curated link against a
 * node-mediated tie), so an operator can tell a claim an author made from
 * a coincidence a shared node produced without reading a label.
 */
function KindDefaults({ colors }: { colors: ColorPalette }): React.JSX.Element {
  return (
    <>
      <Row label="document"><Swatch color={colors.graphNodeDefault} /></Row>
      <Row label="topic"><Swatch color={colors.graphNodeGroup} /></Row>
      <Row label="anchor"><Swatch color={colors.graphNodeAnchor} shape="square" size={10} /></Row>
      <Row label="section"><Swatch color={colors.graphNodeSection} size={7} /></Row>
      <Row label="dangling link"><Swatch color={colors.graphNodeDangling} size={7} /></Row>
      <Row label="curated link"><EdgeSample color={colors.graphEdgeDefault} thickness={2} /></Row>
      <Row label="topic or anchor tie"><EdgeSample color={colors.graphEdgeMediated} thickness={2} /></Row>
      <Row label="supersedes"><EdgeSample color={colors.graphSupersession} thickness={2} /></Row>
    </>
  )
}

export function GraphLegend(): React.JSX.Element | null {
  const colors = useColors()
  const bindings = useGraphStore((s) => s.bindings)
  const model = useGraphStore((s) => s.model)
  const [open, setOpen] = useState(false)
  const scales = useMemo(() => (model ? buildChannelScales(model, bindings, colors) : null), [model, bindings, colors])
  if (!model || !scales) return null

  const boundChannels = (Object.keys(bindings) as ChannelName[]).filter((c) => bindings[c].dimension !== null)
  const chipStyle: React.CSSProperties = {
    padding: '3px 8px',
    borderRadius: 6,
    background: colors.surfaceSecondary,
    border: `1px solid ${colors.containerBorder}`,
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
    cursor: 'pointer',
  }

  if (!open) {
    return (
      <button
        data-testid="graph-legend-chip"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        style={{ ...chipStyle, position: 'absolute', bottom: 8, left: 8 }}
      >
        Legend{boundChannels.length > 0 ? ` · ${boundChannels.length}` : ''}
      </button>
    )
  }

  return (
    <div
      data-testid="graph-legend"
      style={{
        position: 'absolute',
        bottom: 8,
        left: 8,
        padding: '6px 10px 8px',
        borderRadius: 6,
        background: colors.surfaceSecondary,
        border: `1px solid ${colors.containerBorder}`,
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        color: colors.textSecondary,
        maxWidth: 240,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontWeight: 600, color: colors.textPrimary }}>Legend</span>
        <button
          aria-label="Collapse legend"
          onClick={() => setOpen(false)}
          style={{ background: 'none', border: 'none', color: colors.textTertiary, cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1 }}
        >
          ×
        </button>
      </div>
      {boundChannels.length === 0 && <KindDefaults colors={colors} />}
      {boundChannels.map((channel) => {
        const scale = scales[channel]
        const binding = bindings[channel]
        return (
          <React.Fragment key={channel}>
            <Heading channel={channel} binding={binding} />
            {binding.valueType === 'categorical' ? <CategoricalRows channel={channel} scale={scale} /> : <RampRows channel={channel} scale={scale} />}
            {scale.unknownCount > 0 && <Row label={`unknown · ${scale.unknownCount}`}><Swatch color={colors.graphUnknown} /></Row>}
          </React.Fragment>
        )
      })}
    </div>
  )
}
