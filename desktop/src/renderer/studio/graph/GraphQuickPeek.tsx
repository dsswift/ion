/**
 * GraphQuickPeek — lightweight hover popover over the configured
 * `hoverFields`. When `hoverFields` is empty it shows the label, kind, and
 * degree instead. Never changes selection state.
 *
 * A hovered edge gets the same card, describing the claim the line makes:
 * its kind (a curated link, a topic- or anchor-mediated tie, a section's
 * tie to its document), the field that produced it, and its two ends. That
 * is how an operator tells an author's deliberate link from a coincidence
 * a shared node produced.
 *
 * The card is placed beside the node it describes, in the stage's own
 * coordinates, and flipped or clamped against the stage's edges after it is
 * measured. It used to be pinned to the stage's top-right corner, which read
 * as an unrelated panel appearing in the opposite corner from the cursor —
 * with nothing tying it to the node under the pointer.
 */

import React, { useLayoutEffect, useRef, useState } from 'react'
import { useColors } from '../../theme'
import { useGraphStore } from './graph-store'
import type { ColorPalette } from '../../theme-tokens'
import type { GraphEdgeOrigin } from '../../../shared/graph-model-types'

/** The human reading of an edge's origin: what kind of claim the line makes. */
export function edgeKindLabel(origin: GraphEdgeOrigin): string {
  switch (origin) {
    case 'wikilink':
      return 'Curated link (wikilink)'
    case 'markdown-link':
      return 'Curated link (Markdown)'
    case 'front-matter':
      return 'Curated link (front matter)'
    case 'group':
      return 'Shared topic'
    case 'anchor':
      return 'Anchor membership'
    case 'section':
      return 'Section of document'
  }
}

function cardStyle(colors: ColorPalette, placement: { left: number; top: number } | null, at: { x: number; y: number } | null): React.CSSProperties {
  return {
    position: 'absolute',
    left: placement?.left ?? (at?.x ?? 0) + NODE_GAP_PX,
    top: placement?.top ?? at?.y ?? 0,
    visibility: placement ? 'visible' : 'hidden',
    maxWidth: 240,
    padding: '6px 10px',
    borderRadius: 6,
    background: colors.popoverBg,
    border: `1px solid ${colors.popoverBorder}`,
    boxShadow: colors.popoverShadow,
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
    color: colors.textSecondary,
  }
}

/** Clear space between the hovered node and the card, in stage pixels. */
const NODE_GAP_PX = 18
/** Keep the card this far inside the stage's edges. */
const EDGE_MARGIN_PX = 8

export function GraphQuickPeek(): React.JSX.Element | null {
  const colors = useColors()
  const quickPeekNodeId = useGraphStore((s) => s.quickPeekNodeId)
  const model = useGraphStore((s) => s.model)
  const config = useGraphStore((s) => s.config)

  const quickPeekAt = useGraphStore((s) => s.quickPeekAt)
  const quickPeekEdgeId = useGraphStore((s) => s.quickPeekEdgeId)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null)

  const node = quickPeekNodeId && model ? model.nodes.find((n) => n.id === quickPeekNodeId) : null
  const edge = !node && quickPeekEdgeId && model ? model.edges.find((e) => e.id === quickPeekEdgeId) : null

  // Measured, then placed: the card's height depends on how many hover
  // fields the corpus configures, so a guessed height would hang off the
  // bottom edge for any corpus with more fields than the guess assumed.
  useLayoutEffect(() => {
    const card = cardRef.current
    const stage = card?.offsetParent as HTMLElement | null
    if (!card || !stage || !quickPeekAt) {
      setPlacement(null)
      return
    }
    const width = card.offsetWidth
    const height = card.offsetHeight
    const maxLeft = stage.clientWidth - width - EDGE_MARGIN_PX
    const maxTop = stage.clientHeight - height - EDGE_MARGIN_PX
    const preferredLeft = quickPeekAt.x + NODE_GAP_PX
    const left = preferredLeft > maxLeft ? quickPeekAt.x - NODE_GAP_PX - width : preferredLeft
    setPlacement({
      left: Math.max(EDGE_MARGIN_PX, Math.min(left, Math.max(EDGE_MARGIN_PX, maxLeft))),
      top: Math.max(EDGE_MARGIN_PX, Math.min(quickPeekAt.y - height / 2, Math.max(EDGE_MARGIN_PX, maxTop))),
    })
  }, [quickPeekAt, node, edge])

  if (edge && model) {
    const labelOf = (id: string): string => model.nodes.find((n) => n.id === id)?.label ?? id
    return (
      <div
        ref={cardRef}
        data-testid="graph-edge-peek"
        style={{ ...cardStyle(colors, placement, quickPeekAt), pointerEvents: 'none' }}
      >
        <div style={{ fontWeight: 600, color: colors.textPrimary }}>{edgeKindLabel(edge.origin)}</div>
        {edge.field && <div>Field: {edge.field}</div>}
        <div>
          {labelOf(edge.source)} {edge.directed ? '→' : '—'} {labelOf(edge.target)}
        </div>
        {edge.multiplicity > 1 && <div>{edge.multiplicity} references</div>}
        {edge.dangling && <div style={{ color: colors.textTertiary }}>Broken link</div>}
      </div>
    )
  }

  if (!node) return null

  const hoverFields = config?.hoverFields ?? []

  return (
    <div ref={cardRef} style={{ ...cardStyle(colors, placement, quickPeekAt), pointerEvents: 'none' }}>
      {hoverFields.length === 0 ? (
        <>
          <div style={{ fontWeight: 600, color: colors.textPrimary }}>{node.label}</div>
          <div>Kind: {node.kind}</div>
          <div>Degree: {node.degree}</div>
        </>
      ) : (
        hoverFields.map((field) => {
          const value = node.frontMatter[field]
          return (
            <div key={field}>
              {field}: {value === undefined || value === null || value === '' ? <em>unknown</em> : JSON.stringify(value)}
            </div>
          )
        })
      )}
    </div>
  )
}
