import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ArrowsOutSimple, ArrowsInSimple } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1000)}k`
}

export function EngineFooter({ status, isTall, onToggleTall }: Props) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const [hover, setHover] = useState(false)
  const barRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  const handleBarEnter = () => {
    if (barRef.current) {
      const rect = barRef.current.getBoundingClientRect()
      setPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left + rect.width / 2 })
    }
    setHover(true)
  }

  const pct = status?.contextPercent ?? 0
  const cw = status?.contextWindow ?? 0
  const tokens = cw > 0 ? pct * cw / 100 : 0
  const tooltip = cw > 0
    ? `${formatTokens(tokens)} / ${formatTokens(cw)} tokens`
    : `${pct}% context used`

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
            {status.extensionName && (
              <span style={{ color: colors.accent, fontWeight: 600 }}>{status.extensionName}</span>
            )}
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
            <span
              ref={barRef}
              style={{ fontFamily: 'monospace', fontSize: 10, color: colors.textTertiary, cursor: 'default' }}
              onMouseEnter={handleBarEnter}
              onMouseLeave={() => setHover(false)}
            >
              {renderContextBar(status.contextPercent)}
            </span>
            {popoverLayer && hover && createPortal(
              <div
                style={{
                  position: 'fixed',
                  bottom: pos.bottom,
                  left: pos.left,
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none',
                  background: colors.popoverBg,
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  border: `1px solid ${colors.popoverBorder}`,
                  borderRadius: 6,
                  padding: '3px 8px',
                  fontSize: 10,
                  color: colors.textSecondary,
                  whiteSpace: 'nowrap',
                  boxShadow: colors.popoverShadow,
                }}
              >
                {tooltip}
              </div>,
              popoverLayer,
            )}
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
