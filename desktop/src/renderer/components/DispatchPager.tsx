import React from 'react'
import { useColors } from '../theme'
import { formatDuration } from './agent-panel-helpers'
import type { DispatchInfo } from './agent-panel-helpers'

interface Props {
  dispatches: DispatchInfo[]
  selectedIndex: number
  onSelect: (index: number) => void
}

/**
 * Inline pill-bar for switching between dispatch conversations within a
 * single agent row. Pills are shown in reverse chronological order
 * (newest = #1), matching the user's mental model of "most recent first".
 */
export function DispatchPager({ dispatches, selectedIndex, onSelect }: Props) {
  const colors = useColors()
  if (dispatches.length <= 1) return null

  const selected = dispatches[selectedIndex]

  return (
    <div style={{ padding: '4px 12px 2px 148px' }}>
      {/* Pill row */}
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: colors.textTertiary, marginRight: 2 }}>
          Dispatches:
        </span>
        {dispatches.map((d, i) => {
          // Display number: newest first. Dispatches array is chronological,
          // so dispatch[0] is oldest = highest display number.
          const displayNum = dispatches.length - i
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
