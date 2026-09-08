/**
 * GraphBindingPanel — six channel rows (node color/shape/size, edge
 * color/thickness/opacity), each a dimension picker over the live catalog
 * plus a value-type override. Rebinding calls `setBinding`/
 * `overrideValueType` only; nothing here touches drawing code.
 */

import React from 'react'
import { useColors } from '../../theme'
import { buildDimensionCatalog, type CatalogEntry } from './channels/dimension-catalog'
import { useGraphStore, defaultChannelBindings } from './graph-store'
import type { ChannelBindings, ChannelDimension, ChannelValueType } from '../../../shared/graph-view-types'

type ChannelName = keyof ChannelBindings

const NODE_CHANNEL_ROWS: { channel: ChannelName; label: string }[] = [
  { channel: 'nodeColor', label: 'Node color' },
  { channel: 'nodeShape', label: 'Node shape' },
  { channel: 'nodeSize', label: 'Node size' },
]
const EDGE_CHANNEL_ROWS: { channel: ChannelName; label: string }[] = [
  { channel: 'edgeColor', label: 'Edge color' },
  { channel: 'edgeThickness', label: 'Edge thickness' },
  { channel: 'edgeOpacity', label: 'Edge opacity' },
]

function dimensionKey(dimension: ChannelDimension | null): string {
  if (!dimension) return ''
  if (dimension.source === 'frontMatter') return `frontMatter:${dimension.field}`
  if (dimension.source === 'structural') return `structural:${dimension.metric}`
  if (dimension.source === 'mechanical') return `mechanical:${dimension.property}`
  return `edge:${dimension.metric}`
}

function findByKey(catalog: CatalogEntry[], key: string): ChannelDimension | null {
  if (!key) return null
  return catalog.find((e) => dimensionKey(e.dimension) === key)?.dimension ?? null
}

function ChannelRow({ channel, label, catalog }: { channel: ChannelName; label: string; catalog: CatalogEntry[] }): React.JSX.Element {
  const colors = useColors()
  const bindings = useGraphStore((s) => s.bindings)
  const setBinding = useGraphStore((s) => s.setBinding)
  const overrideValueType = useGraphStore((s) => s.overrideValueType)
  const binding = bindings[channel] ?? defaultChannelBindings()[channel]

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <div style={{ width: 110, fontSize: 11, color: colors.textSecondary }}>{label}</div>
      <select
        value={dimensionKey(binding.dimension)}
        onChange={(e) => setBinding(channel, findByKey(catalog, e.target.value))}
        style={{ flex: 1, fontSize: 11, background: colors.surfaceSecondary, color: colors.textPrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 4, padding: '2px 4px' }}
      >
        <option value="">Unbound</option>
        {catalog.map((entry) => (
          <option key={dimensionKey(entry.dimension)} value={dimensionKey(entry.dimension)}>
            {entry.displayName}
          </option>
        ))}
      </select>
      {binding.dimension && (
        <select
          value={binding.valueType}
          onChange={(e) => overrideValueType(channel, e.target.value as ChannelValueType)}
          style={{ fontSize: 11, background: colors.surfaceSecondary, color: colors.textPrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 4, padding: '2px 4px' }}
        >
          <option value="categorical">Categorical</option>
          <option value="numeric">Numeric</option>
          <option value="temporal">Temporal</option>
        </select>
      )}
    </div>
  )
}

export function GraphBindingPanel(): React.JSX.Element {
  const colors = useColors()
  const model = useGraphStore((s) => s.model)
  const config = useGraphStore((s) => s.config)
  const tagTreatment = useGraphStore((s) => s.tagTreatment)

  const tagContext = config ? { tagField: config.tagField, tagTreatment } : undefined
  const nodeCatalog = model ? buildDimensionCatalog(model, config?.curatedFields ?? [], 'node', tagContext) : []
  const edgeCatalog = model ? buildDimensionCatalog(model, config?.curatedFields ?? [], 'edge', tagContext) : []

  return (
    <div style={{ padding: '4px 12px 12px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: colors.textSecondary, marginBottom: 4 }}>Node encoding</div>
      {NODE_CHANNEL_ROWS.map((row) => (
        <ChannelRow key={row.channel} channel={row.channel} label={row.label} catalog={nodeCatalog} />
      ))}
      <div style={{ fontSize: 11, fontWeight: 600, color: colors.textSecondary, marginTop: 8, marginBottom: 4 }}>Edge encoding</div>
      {EDGE_CHANNEL_ROWS.map((row) => (
        <ChannelRow key={row.channel} channel={row.channel} label={row.label} catalog={edgeCatalog} />
      ))}
    </div>
  )
}
