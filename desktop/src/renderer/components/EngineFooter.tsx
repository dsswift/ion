import React from 'react'
import { ArrowsOutSimple, ArrowsInSimple } from '@phosphor-icons/react'
import { useColors } from '../theme'
import type { StatusFields } from '../../shared/types'

interface Props {
  status: StatusFields | null
  isTall: boolean
  onToggleTall: () => void
}

function renderContextBar(percent: number): string {
  const filled = Math.round(percent / 10)
  const empty = 10 - filled
  return '[' + '#'.repeat(filled) + '.'.repeat(empty) + '] ' + percent + '%'
}

export function EngineFooter({ status, isTall, onToggleTall }: Props) {
  const colors = useColors()

  return (
    <div
      data-ion-ui
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 24,
        borderTop: `1px solid ${colors.containerBorder}`,
        padding: '0 12px',
        fontSize: 11,
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {/* Left: label, state, team, model */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
        {status ? (
          <>
            <span style={{ color: colors.accent, fontWeight: 600 }}>{status.label}</span>
            <span style={{ color: colors.textTertiary }}>[{status.state}]</span>
            {status.team && <>
              <span style={{ color: colors.textTertiary }}>|</span>
              <span style={{ color: colors.textSecondary }}>{status.team}</span>
            </>}
            <span style={{ color: colors.textTertiary }}>|</span>
            <span style={{ color: colors.textSecondary }}>{status.model}</span>
            {status.backend !== 'api' && <>
              <span style={{ color: colors.textTertiary }}>|</span>
              <span style={{ color: '#e5a100', fontSize: 10, fontWeight: 500 }}>via CLI</span>
            </>}
          </>
        ) : (
          <span style={{ color: colors.textTertiary }}>--</span>
        )}
      </div>

      {/* Right: context bar, cost, toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {status && (
          <>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: colors.textTertiary }}>
              {renderContextBar(status.contextPercent)}
            </span>
            {status.totalCostUsd != null && status.totalCostUsd > 0 && (
              <span style={{ color: colors.textTertiary, fontSize: 10 }}>
                ${status.totalCostUsd.toFixed(2)}
              </span>
            )}
          </>
        )}
        <button
          data-ion-ui
          onClick={onToggleTall}
          title={isTall ? 'Collapse view' : 'Expand view'}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: colors.textTertiary,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {isTall ? <ArrowsInSimple size={12} /> : <ArrowsOutSimple size={12} />}
        </button>
      </div>
    </div>
  )
}
