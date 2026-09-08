/**
 * GraphInspector — full analytical detail for the selected node: its
 * structural metrics, every discovered front-matter field, and the links
 * that actually reach it. Closes when selection clears (empty canvas click,
 * or the node is removed by a delta/filter).
 *
 * The link lists are the point of the panel. A node's neighbours are the
 * thing an operator is reading the graph to find, and clicking one selects
 * it, so the inspector walks the corpus the same way the stage does. A
 * broken outbound link is listed and marked rather than silently omitted —
 * the corpus wrote it, so the panel shows it, and selecting it opens the
 * dangling node the model already carries for it.
 */

import React, { useMemo } from 'react'
import { useColors } from '../../theme'
import { useGraphStore } from './graph-store'
import type { GraphModel, GraphNode } from '../../../shared/graph-model-types'

interface Neighbour {
  id: string
  label: string
  origin: string
  dangling: boolean
}

/** Split the selected node's edges into what it points at and what points at it. */
function neighboursOf(model: GraphModel, nodeId: string): { outgoing: Neighbour[]; incoming: Neighbour[] } {
  const labelOf = new Map(model.nodes.map((n) => [n.id, n.label]))
  const outgoing: Neighbour[] = []
  const incoming: Neighbour[] = []
  for (const edge of model.edges) {
    if (edge.source === nodeId) {
      outgoing.push({ id: edge.target, label: labelOf.get(edge.target) ?? edge.target, origin: edge.origin, dangling: edge.dangling })
    } else if (edge.target === nodeId) {
      incoming.push({ id: edge.source, label: labelOf.get(edge.source) ?? edge.source, origin: edge.origin, dangling: false })
    }
  }
  return { outgoing, incoming }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ')
  return JSON.stringify(value) ?? ''
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ display: 'flex', gap: 8, padding: '2px 0', alignItems: 'baseline' }}>
      <div style={{ flex: '0 0 84px', color: colors.textTertiary }}>{label}</div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          color: colors.textSecondary,
          fontFamily: mono ? 'ui-monospace, monospace' : undefined,
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textTertiary, margin: '14px 0 4px' }}>
      {children}
    </div>
  )
}

function NeighbourList({ items, empty }: { items: Neighbour[]; empty: string }): React.JSX.Element {
  const colors = useColors()
  const selectNode = useGraphStore((s) => s.selectNode)
  if (items.length === 0) return <div style={{ color: colors.textTertiary, padding: '2px 0' }}>{empty}</div>

  return (
    <>
      {items.map((item, i) => (
        <button
          key={`${item.id}-${i}`}
          onClick={() => selectNode(item.id)}
          title={item.dangling ? 'Broken link — no document resolves this target' : item.id}
          style={{
            display: 'flex',
            width: '100%',
            gap: 6,
            alignItems: 'baseline',
            textAlign: 'left',
            background: 'none',
            border: 'none',
            padding: '2px 0',
            fontSize: 11,
            fontFamily: 'inherit',
            color: item.dangling ? colors.textTertiary : colors.accent,
            cursor: 'pointer',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.dangling ? `${item.label} (broken)` : item.label}
          </span>
          <span style={{ color: colors.textTertiary, flex: '0 0 auto' }}>{item.origin}</span>
        </button>
      ))}
    </>
  )
}

function Header({ node }: { node: GraphNode }): React.JSX.Element {
  const colors = useColors()
  const selectNode = useGraphStore((s) => s.selectNode)
  const requestOpenFile = useGraphStore((s) => s.requestOpenFile)
  const togglePin = useGraphStore((s) => s.togglePin)
  const pinned = useGraphStore((s) => s.pinnedNodeIds.has(node.id))
  const expanded = useGraphStore((s) => s.scope.mode === 'neighborhood' && (s.scope.expandedIds?.has(node.id) ?? false))
  const drillInto = useGraphStore((s) => s.drillInto)
  const collapseNodeScope = useGraphStore((s) => s.collapseNodeScope)
  const actionStyle: React.CSSProperties = {
    background: colors.surfaceSecondary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 6,
    color: colors.textSecondary,
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: 'inherit',
    padding: '2px 8px',
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary, overflowWrap: 'anywhere' }}>{node.label}</div>
        <div style={{ color: colors.textTertiary, marginTop: 2 }}>{node.kind}</div>
      </div>
      <div style={{ display: 'flex', gap: 4, flex: '0 0 auto' }}>
        <button onClick={() => togglePin(node.id)} style={{ ...actionStyle, ...(pinned ? { color: colors.textPrimary, border: `1px solid ${colors.accentBorderMedium}` } : {}) }}>
          {pinned ? 'Unpin' : 'Pin'}
        </button>
        {expanded ? (
          <button onClick={() => collapseNodeScope(node.id)} style={actionStyle} title="Undo this node's expansion (C)">
            Collapse
          </button>
        ) : (
          <button onClick={() => drillInto(node.id)} style={actionStyle} title="Bring this node's neighbours in (E)">
            Expand
          </button>
        )}
        {node.path && (
          <button onClick={() => requestOpenFile(node.id)} style={actionStyle}>
            Open
          </button>
        )}
        <button
          onClick={() => selectNode(null)}
          aria-label="Close inspector"
          style={{ background: 'none', border: 'none', color: colors.textTertiary, cursor: 'pointer', fontSize: 13, padding: 2 }}
        >
          ×
        </button>
      </div>
    </div>
  )
}

/**
 * With several nodes selected the inspector leads with the selection itself:
 * a count and one row per node, each narrowing the selection to that node.
 * The detail below is for the most recently added node.
 */
function SelectionList({ ids, model }: { ids: string[]; model: GraphModel }): React.JSX.Element {
  const colors = useColors()
  const selectNode = useGraphStore((s) => s.selectNode)
  const labelOf = new Map(model.nodes.map((n) => [n.id, n.label]))
  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>{ids.length} selected</div>
      <div style={{ color: colors.textTertiary, marginTop: 2 }}>Shift+click adds or removes a node</div>
      <SectionTitle>Selection</SectionTitle>
      {ids.map((id) => (
        <button
          key={id}
          onClick={() => selectNode(id)}
          title="Narrow the selection to this node"
          style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '2px 0', fontSize: 11, fontFamily: 'inherit', color: colors.accent, cursor: 'pointer' }}
        >
          {labelOf.get(id) ?? id}
        </button>
      ))}
    </>
  )
}

export function GraphInspector(): React.JSX.Element | null {
  const colors = useColors()
  const selectedNodeIds = useGraphStore((s) => s.selectedNodeIds)
  const model = useGraphStore((s) => s.model)
  const pinnedNodeIds = useGraphStore((s) => s.pinnedNodeIds)

  // Sets iterate in insertion order, so the last entry is the newest addition.
  const selectedIds = [...selectedNodeIds]
  const focusId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null
  const node = focusId && model ? model.nodes.find((n) => n.id === focusId) : null
  const links = useMemo(() => (model && focusId ? neighboursOf(model, focusId) : null), [model, focusId])
  if (!node || !links || !model) return null
  const pinnedHere = pinnedNodeIds.has(node.id)

  const frontMatter = Object.entries(node.frontMatter)

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 300,
        background: colors.surfacePrimary,
        borderLeft: `1px solid ${colors.containerBorder}`,
        padding: 12,
        overflowY: 'auto',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 11,
      }}
    >
      {selectedIds.length > 1 && <SelectionList ids={selectedIds} model={model} />}
      <Header node={node} />

      <SectionTitle>Structure</SectionTitle>
      <Row label="Degree" value={String(node.degree)} />
      <Row label="Community" value={node.community < 0 ? 'none' : String(node.community)} />
      <Row label="Centrality" value={node.centrality.toFixed(3)} />
      <Row label="Orphan" value={node.orphan ? 'yes' : 'no'} />
      <Row label="Pinned" value={pinnedHere ? 'yes' : 'no'} />

      <SectionTitle>Source</SectionTitle>
      <Row label="Identity" value={node.id} mono />
      {node.path && <Row label="Path" value={node.path} mono />}
      {node.rootPath && <Row label="Root" value={node.rootPath} mono />}

      <SectionTitle>Links out ({links.outgoing.length})</SectionTitle>
      <NeighbourList items={links.outgoing} empty="No outgoing links" />

      <SectionTitle>Links in ({links.incoming.length})</SectionTitle>
      <NeighbourList items={links.incoming} empty="No incoming links" />

      {frontMatter.length > 0 && (
        <>
          <SectionTitle>Front matter</SectionTitle>
          {frontMatter.map(([key, value]) => (
            <Row key={key} label={key} value={formatValue(value)} />
          ))}
        </>
      )}
    </div>
  )
}
