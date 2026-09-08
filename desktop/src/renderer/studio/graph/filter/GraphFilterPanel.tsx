/**
 * GraphFilterPanel — a bidirectional rule editor over `GraphFilterRule[]`,
 * plus the layer toggles and the visibility facts that sit beside the rules.
 *
 * Each rule row is a dimension, a mode (include/exclude), a match (exact or
 * prefix), and a value set or numeric bounds. Rules AND together; an
 * unfinished (empty) rule is inert rather than blanking the canvas.
 *
 * The layers are the view-time toggles the requirement asks for: topic
 * nodes (the tag treatment), section nodes, and each promoted anchor
 * property. Toggling is a view control, never a settings change, and a
 * suppressed anchor value is reported here rather than silently withheld.
 */

import React from 'react'
import { useColors } from '../../../theme'
import { buildDimensionCatalog } from '../channels/dimension-catalog'
import { useGraphStore } from '../graph-store'
import type { GraphFilterRule, GraphFilterMatch, TagTreatment } from '../../../../shared/graph-view-types'

const TAG_TREATMENTS: { value: TagTreatment; label: string; hint: string }[] = [
  { value: 'filter', label: 'Filter', hint: 'Topics are filterable and bindable but draw no node' },
  { value: 'nodes', label: 'Nodes', hint: 'Each topic value is a node the documents carrying it connect to' },
  { value: 'off', label: 'Off', hint: 'Topics take no part in the graph' },
]

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontWeight: 600, color: colors.textSecondary, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  )
}

function Layers(): React.JSX.Element {
  const colors = useColors()
  const model = useGraphStore((s) => s.model)
  const config = useGraphStore((s) => s.config)
  const tagTreatment = useGraphStore((s) => s.tagTreatment)
  const setTagTreatment = useGraphStore((s) => s.setTagTreatment)
  const sectionNodes = useGraphStore((s) => s.sectionNodes)
  const setSectionNodes = useGraphStore((s) => s.setSectionNodes)
  const promotedFields = useGraphStore((s) => s.promotedFields)
  const setPromotedField = useGraphStore((s) => s.setPromotedField)
  const sectionCount = model ? model.nodes.filter((n) => n.kind === 'section').length : 0
  const selectStyle: React.CSSProperties = { fontSize: 11, background: colors.surfaceSecondary, color: colors.textPrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 4 }
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', color: colors.textSecondary }

  return (
    <Section title="Layers">
      <label style={rowStyle}>
        <span style={{ flex: 1 }}>Topic nodes ({config?.tagField ?? 'tags'})</span>
        <select value={tagTreatment} onChange={(e) => setTagTreatment(e.target.value as TagTreatment)} aria-label="Topic treatment" style={selectStyle}>
          {TAG_TREATMENTS.map((t) => (
            <option key={t.value} value={t.value} title={t.hint}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label style={{ ...rowStyle, cursor: 'pointer' }}>
        <input type="checkbox" checked={sectionNodes} onChange={(e) => setSectionNodes(e.target.checked)} style={{ margin: 0 }} />
        Section nodes
        <span style={{ color: colors.textTertiary }}>{sectionNodes ? `(${sectionCount})` : ''}</span>
      </label>
      {(config?.promotedFields ?? []).map((promoted) => {
        const on = promotedFields.has(promoted.field)
        const suppressed = model?.anchorSuppressions.filter((s) => s.field === promoted.field) ?? []
        const anchorCount = model ? model.nodes.filter((n) => n.kind === 'anchor' && n.id.startsWith(`anchor:${promoted.field}:`)).length : 0
        const whole = suppressed.find((s) => s.value === null)
        return (
          <div key={promoted.field}>
            <label style={{ ...rowStyle, cursor: 'pointer' }}>
              <input type="checkbox" checked={on} onChange={(e) => setPromotedField(promoted.field, e.target.checked)} style={{ margin: 0 }} />
              Anchors: {promoted.field}
              {promoted.depth ? <span style={{ color: colors.textTertiary }}>depth {promoted.depth}</span> : null}
              {on && <span style={{ color: colors.textTertiary }}>({anchorCount})</span>}
            </label>
            {on && whole && (
              <div style={{ color: colors.textTertiary, paddingLeft: 20 }}>
                Suppressed whole: every value is a hub on {whole.documentCount} documents at this depth
              </div>
            )}
            {on && !whole && suppressed.length > 0 && (
              <div style={{ color: colors.textTertiary, paddingLeft: 20 }} title={suppressed.map((s) => `${s.value}: ${s.reason} (${s.documentCount})`).join('\n')}>
                {suppressed.filter((s) => s.reason === 'hub').length} hub value(s) and {suppressed.filter((s) => s.reason === 'singleton').length} singleton(s) not drawn
              </div>
            )}
          </div>
        )
      })}
    </Section>
  )
}

export function GraphFilterPanel(): React.JSX.Element {
  const colors = useColors()
  const model = useGraphStore((s) => s.model)
  const config = useGraphStore((s) => s.config)
  const filters = useGraphStore((s) => s.filters)
  const setFilters = useGraphStore((s) => s.setFilters)
  const visibleNodeIds = useGraphStore((s) => s.visibleNodeIds)
  const showOrphans = useGraphStore((s) => s.showOrphans)
  const setShowOrphans = useGraphStore((s) => s.setShowOrphans)
  const showDangling = useGraphStore((s) => s.showDangling)
  const setShowDangling = useGraphStore((s) => s.setShowDangling)
  const hiddenNodeIds = useGraphStore((s) => s.hiddenNodeIds)
  const unhideAllNodes = useGraphStore((s) => s.unhideAllNodes)

  const tagTreatment = useGraphStore((s) => s.tagTreatment)
  const orphanCount = model ? model.nodes.filter((n) => n.kind === 'document' && n.orphan).length : 0
  const danglingCount = model ? model.nodes.filter((n) => n.kind === 'dangling').length : 0

  const catalog = model
    ? buildDimensionCatalog(model, config?.curatedFields ?? [], 'node', config ? { tagField: config.tagField, tagTreatment } : undefined)
    : []

  function updateRule(index: number, patch: Partial<GraphFilterRule>): void {
    const next = filters.map((r, i) => (i === index ? { ...r, ...patch } : r))
    setFilters(next)
  }

  function removeRule(index: number): void {
    setFilters(filters.filter((_, i) => i !== index))
  }

  function addRule(): void {
    const first = catalog[0]
    if (!first) return
    setFilters([...filters, { dimension: first.dimension, mode: 'include', values: [] }])
  }

  const selectStyle: React.CSSProperties = { fontSize: 11, background: colors.surfaceSecondary, color: colors.textPrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 4 }
  const checkRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', color: colors.textSecondary, cursor: 'pointer' }

  return (
    <div style={{ padding: '4px 12px 12px', fontFamily: 'system-ui, sans-serif', fontSize: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontWeight: 600, color: colors.textSecondary }}>Filters</div>
        <div style={{ color: colors.textTertiary }}>
          {model ? `${visibleNodeIds.size} of ${model.nodes.length} visible` : ''}
        </div>
      </div>
      {filters.map((rule, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
          <select value={rule.mode} onChange={(e) => updateRule(i, { mode: e.target.value as 'include' | 'exclude' })} style={selectStyle}>
            <option value="include">Include</option>
            <option value="exclude">Exclude</option>
          </select>
          <select
            value={catalog.findIndex((c) => JSON.stringify(c.dimension) === JSON.stringify(rule.dimension))}
            onChange={(e) => {
              const entry = catalog[Number(e.target.value)]
              if (entry) updateRule(i, { dimension: entry.dimension })
            }}
            style={{ ...selectStyle, maxWidth: 120 }}
          >
            {/* A rule whose dimension left the catalog (a field that vanished
                from the corpus, or the tag field under the 'off' treatment)
                still has to render as something selectable, or changing any
                other rule would silently rewrite this one. */}
            {catalog.every((c) => JSON.stringify(c.dimension) !== JSON.stringify(rule.dimension)) && (
              <option value={-1}>(unavailable)</option>
            )}
            {catalog.map((c, ci) => (
              <option key={ci} value={ci}>
                {c.displayName}
              </option>
            ))}
          </select>
          <select value={rule.match ?? 'exact'} onChange={(e) => updateRule(i, { match: e.target.value as GraphFilterMatch })} aria-label="Match" title="Exact matches a whole value; prefix matches the start (everything under a path)" style={selectStyle}>
            <option value="exact">is</option>
            <option value="prefix">starts with</option>
          </select>
          <input
            type="text"
            placeholder="values (comma separated)"
            value={(rule.values ?? []).join(',')}
            onChange={(e) => updateRule(i, { values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })}
            style={{ flex: 1, minWidth: 60, fontSize: 11, background: colors.surfaceSecondary, color: colors.textPrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 4, padding: '2px 4px' }}
          />
          <button onClick={() => removeRule(i)} style={{ background: 'none', border: 'none', color: colors.textTertiary, cursor: 'pointer' }}>
            ×
          </button>
        </div>
      ))}
      <button
        onClick={addRule}
        disabled={catalog.length === 0}
        style={{ marginTop: 6, fontSize: 11, background: colors.surfaceSecondary, color: colors.textSecondary, border: `1px solid ${colors.containerBorder}`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer' }}
      >
        + Add filter
      </button>
      {model && visibleNodeIds.size === 0 && (
        <div style={{ marginTop: 6, color: colors.textTertiary }}>
          0 of {model.nodes.length} visible.{' '}
          <button onClick={() => setFilters([])} style={{ background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0 }}>
            Clear filters
          </button>
        </div>
      )}

      <Section title="Show">
        <label style={checkRow}>
          <input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} style={{ margin: 0 }} />
          Show orphans
          <span style={{ color: colors.textTertiary }}>({orphanCount})</span>
        </label>
        <label style={checkRow}>
          <input type="checkbox" checked={showDangling} onChange={(e) => setShowDangling(e.target.checked)} style={{ margin: 0 }} />
          Show broken links
          <span style={{ color: colors.textTertiary }}>({danglingCount})</span>
        </label>
        {hiddenNodeIds.size > 0 && (
          <div style={{ padding: '3px 0', color: colors.textSecondary }}>
            {hiddenNodeIds.size} hidden by hand.{' '}
            <button onClick={unhideAllNodes} style={{ background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: 11 }}>
              Unhide all
            </button>
          </div>
        )}
      </Section>

      <Layers />
    </div>
  )
}
