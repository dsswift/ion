/**
 * GraphSearchBox — jumps to a node by label, identity, or path,
 * case-insensitively, over the whole corpus regardless of the active
 * scope or filters.
 */

import React, { useState } from 'react'
import { useColors } from '../../../theme'
import { useGraphStore } from '../graph-store'

export function GraphSearchBox(): React.JSX.Element {
  const colors = useColors()
  const [q, setQ] = useState('')
  const search = useGraphStore((s) => s.search)
  const jumpToSearchResult = useGraphStore((s) => s.jumpToSearchResult)
  const results = q.trim().length > 0 ? search(q) : []

  return (
    <div style={{ position: 'relative', width: 220, pointerEvents: 'auto' }}>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search the corpus…"
        style={{
          // Matches the Encoding / Filters / Views buttons beside it: same
          // font stack, size, radius, and border. Without the explicit
          // family the input inherits the platform form font and renders a
          // visibly taller, differently-shaped control in the same row.
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 11,
          background: colors.surfaceSecondary,
          color: colors.textPrimary,
          border: `1px solid ${colors.containerBorder}`,
          borderRadius: 6,
          padding: '3px 8px',
          outline: 'none',
        }}
      />
      {results.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 2,
            background: colors.popoverBg,
            border: `1px solid ${colors.popoverBorder}`,
            borderRadius: 6,
            boxShadow: colors.popoverShadow,
            maxHeight: 220,
            overflowY: 'auto',
            zIndex: 10,
          }}
        >
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                jumpToSearchResult(r.id)
                setQ('')
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                fontFamily: 'system-ui, sans-serif',
                fontSize: 11,
                padding: '4px 8px',
                background: 'none',
                border: 'none',
                color: colors.textPrimary,
                cursor: 'pointer',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
