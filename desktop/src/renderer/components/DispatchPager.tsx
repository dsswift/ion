import React from 'react'
import { useColors } from '../theme'
import { formatDuration } from './agent-panel-helpers'
import type { DispatchInfo } from './agent-panel-helpers'

interface Props {
  dispatches: DispatchInfo[]
  selectedIndex: number
  onSelect: (index: number) => void
  /** When true, remove the left indent padding (used in popup/fullscreen mode) */
  compact?: boolean
}

/**
 * Inline pill-bar for switching between dispatch conversations within a
 * single agent row. Pills are shown in reverse chronological order
 * (newest = #1), matching the user's mental model of "most recent first".
 */
export function DispatchPager({ dispatches, selectedIndex, onSelect, compact }: Props) {
  const colors = useColors()
  if (dispatches.length <= 1) return null

  const selected = dispatches[selectedIndex]

  return (
    <div style={{ padding: compact ? '4px 12px 2px 12px' : '4px 12px 2px 148px' }}>
      {/* Pill row — reversed so newest dispatch appears first (leftmost) */}
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: colors.textTertiary, marginRight: 2 }}>
          Dispatches:
        </span>
        {[...dispatches].reverse().map((d, ri) => {
          // ri is the reversed index; map back to the original array index.
          // Display number = chronological position (1 = first, N = most recent).
          const i = dispatches.length - 1 - ri
          const displayNum = i + 1
          const isActive = i === selectedIndex
          return (
            <button
              key={d.id || i}
              onClick={(e) => { e.stopPropagation(); onSelect(i) }}
              style={{
                background: isActive ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
                border: isActive ? '1px solid rgba(255,255,255,0.2)' : '1px solid rgba(255,255,255,0.06)',
                borderRadius: 4,
                padding: '1px 6px',
                fontSize: 10,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? colors.textPrimary : colors.textTertiary,
                cursor: 'pointer',
                transition: 'all 0.1s ease',
              }}
              title={d.task || `Dispatch #${displayNum}`}
            >
              #{displayNum}
              {d.status === 'running' && ' ●'}
            </button>
          )
        })}
      </div>

      {/* Selected dispatch info */}
      {selected && (
        <div style={{
          display: 'flex',
          gap: 6,
          fontSize: 9,
          color: colors.textTertiary,
          marginTop: 2,
          alignItems: 'center',
        }}>
          {selected.model && <span>{selected.model}</span>}
          {selected.elapsed != null && (
            <>
              {selected.model && <span style={{ opacity: 0.4 }}>·</span>}
              <span>{formatDuration(Math.round(selected.elapsed))}</span>
            </>
          )}
          {selected.task && (
            <>
              <span style={{ opacity: 0.4 }}>·</span>
              <span style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 300,
              }}>
                {selected.task}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
